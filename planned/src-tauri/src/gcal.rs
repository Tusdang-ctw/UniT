//! Google Calendar OAuth (PKCE) + event sync.
//!
//! The user must provide their own OAuth Client ID (type: "Desktop app")
//! from Google Cloud Console. Scope requested: calendar.events.
//!
//! Tokens are stored in the OS keyring under the "planned-app" service.

use crate::commands::{AppError, CommandResult, Task};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::AppHandle;

const KEYRING_SERVICE: &str = "unit-app";
const KEYRING_USER: &str = "google-oauth";
const SCOPES: &str = "https://www.googleapis.com/auth/calendar.events";
const REDIRECT_PATH: &str = "/oauth/callback";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64, // ms epoch
}

fn keyring_entry() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| AppError::Other(format!("keyring: {e}")))
}

fn load_tokens() -> Result<Option<Tokens>, AppError> {
    let e = keyring_entry()?;
    match e.get_password() {
        Ok(s) => Ok(Some(serde_json::from_str(&s)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(AppError::Other(format!("keyring: {err}"))),
    }
}

fn save_tokens(t: &Tokens) -> Result<(), AppError> {
    let s = serde_json::to_string(t)?;
    keyring_entry()?
        .set_password(&s)
        .map_err(|e| AppError::Other(format!("keyring: {e}")))
}

fn delete_tokens() -> Result<(), AppError> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!("keyring: {e}"))),
    }
}

fn rand_string(n: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(n)
        .map(char::from)
        .collect()
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

// ————— Commands —————

#[tauri::command]
pub async fn gcal_connect(_app: AppHandle, client_id: String) -> CommandResult<bool> {
    if client_id.trim().is_empty() {
        return Err(AppError::Other(
            "Google OAuth client ID is empty. Create a Desktop app client in Google Cloud Console."
                .into(),
        ));
    }

    // Start loopback listener.
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| AppError::Other(format!("loopback: {e}")))?;
    let port = server.server_addr().to_ip().unwrap().port();
    let redirect_uri = format!("http://127.0.0.1:{}{}", port, REDIRECT_PATH);

    let verifier = rand_string(64);
    let challenge = code_challenge(&verifier);
    let state = rand_string(24);

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?\
         client_id={}&redirect_uri={}&response_type=code&scope={}&\
         code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent&state={}",
        urlencoding(&client_id),
        urlencoding(&redirect_uri),
        urlencoding(SCOPES),
        urlencoding(&challenge),
        urlencoding(&state),
    );

    webbrowser::open(&auth_url).map_err(|e| AppError::Other(format!("open browser: {e}")))?;

    // Run the blocking listener in a worker thread so we can apply a timeout.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let result = wait_for_code(&server, &state);
        let _ = tx.send(result);
    });

    let code = match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(Ok(c))) => c,
        Ok(Ok(Err(e))) => return Err(AppError::Other(e)),
        Ok(Err(_)) => return Err(AppError::Other("oauth channel closed".into())),
        Err(_) => return Err(AppError::Other("oauth timed out".into())),
    };

    // Exchange code for tokens.
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Other(format!("token exchange: {e}")))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("token exchange failed: {body}")));
    }

    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        expires_in: i64,
        refresh_token: Option<String>,
    }
    let tok: TokenResp = resp
        .json()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let expires_at = chrono::Utc::now().timestamp_millis() + tok.expires_in * 1000;
    save_tokens(&Tokens {
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at,
    })?;
    Ok(true)
}

#[tauri::command]
pub async fn gcal_disconnect() -> CommandResult<()> {
    delete_tokens()
}

#[tauri::command]
pub async fn gcal_status() -> CommandResult<bool> {
    Ok(load_tokens()?.is_some())
}

#[tauri::command]
pub async fn gcal_push_task(client_id: String, mut task: Task) -> CommandResult<Task> {
    let access = ensure_access_token(&client_id).await?;
    let (start, end) = match event_times(&task) {
        Some(t) => t,
        None => return Err(AppError::Other("task needs date and time".into())),
    };

    #[derive(Serialize)]
    struct EventBody<'a> {
        summary: &'a str,
        description: &'a str,
        start: DateTime<'a>,
        end: DateTime<'a>,
    }
    #[derive(Serialize)]
    struct DateTime<'a> {
        #[serde(rename = "dateTime")]
        date_time: &'a str,
    }
    let body = EventBody {
        summary: &task.title,
        description: &task.note,
        start: DateTime { date_time: &start },
        end: DateTime { date_time: &end },
    };

    let client = reqwest::Client::new();
    let resp = if let Some(evt_id) = task.gcal_event_id.as_deref() {
        client
            .put(format!(
                "https://www.googleapis.com/calendar/v3/calendars/primary/events/{}",
                evt_id
            ))
            .bearer_auth(&access)
            .json(&body)
            .send()
            .await
    } else {
        client
            .post("https://www.googleapis.com/calendar/v3/calendars/primary/events")
            .bearer_auth(&access)
            .json(&body)
            .send()
            .await
    };
    let resp = resp.map_err(|e| AppError::Other(e.to_string()))?;
    if !resp.status().is_success() {
        let s = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("gcal {}: {}", s, txt)));
    }
    #[derive(Deserialize)]
    struct Created {
        id: String,
    }
    let c: Created = resp
        .json()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    task.gcal_event_id = Some(c.id);
    task.gcal_synced = true;
    Ok(task)
}

// ————— Helpers —————

fn wait_for_code(server: &tiny_http::Server, expected_state: &str) -> Result<String, String> {
    for req in server.incoming_requests() {
        if !req.url().starts_with(REDIRECT_PATH) {
            let _ =
                req.respond(tiny_http::Response::from_string("Not found").with_status_code(404));
            continue;
        }
        let full = format!("http://localhost{}", req.url());
        let parsed = url::Url::parse(&full).map_err(|e| format!("bad url: {e}"))?;
        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        let mut err: Option<String> = None;
        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.to_string()),
                "state" => state = Some(v.to_string()),
                "error" => err = Some(v.to_string()),
                _ => {}
            }
        }
        let body = "<html><body style=\"font-family:system-ui;padding:40px;text-align:center\"><h2>You can close this tab.</h2><p>Planned has finished connecting to Google Calendar.</p></body></html>";
        let _ = req.respond(
            tiny_http::Response::from_string(body).with_header(
                "Content-Type: text/html"
                    .parse::<tiny_http::Header>()
                    .unwrap(),
            ),
        );
        if let Some(e) = err {
            return Err(format!("oauth error: {e}"));
        }
        if state.as_deref() != Some(expected_state) {
            return Err("state mismatch".into());
        }
        if let Some(c) = code {
            return Ok(c);
        }
        return Err("no code in callback".into());
    }
    Err("server closed".into())
}

async fn ensure_access_token(client_id: &str) -> Result<String, AppError> {
    let mut tok = load_tokens()?.ok_or_else(|| AppError::Other("not connected".into()))?;
    let now = chrono::Utc::now().timestamp_millis();
    if tok.expires_at - 60_000 > now {
        return Ok(tok.access_token);
    }
    let refresh = tok
        .refresh_token
        .clone()
        .ok_or_else(|| AppError::Other("no refresh token; reconnect".into()))?;
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("refresh_token", refresh.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!("refresh failed: {body}")));
    }
    #[derive(Deserialize)]
    struct R {
        access_token: String,
        expires_in: i64,
    }
    let r: R = resp
        .json()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    tok.access_token = r.access_token.clone();
    tok.expires_at = chrono::Utc::now().timestamp_millis() + r.expires_in * 1000;
    save_tokens(&tok)?;
    Ok(r.access_token)
}

fn event_times(t: &Task) -> Option<(String, String)> {
    let due = t.due.as_deref()?;
    let time = t.time.as_deref()?;
    use chrono::{Duration as CD, NaiveDate, NaiveDateTime, NaiveTime};
    let d = NaiveDate::parse_from_str(due, "%Y-%m-%d").ok()?;
    let tm = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    let start = NaiveDateTime::new(d, tm);
    let end = start + CD::minutes(t.duration.max(15));
    let tz = chrono::Local::now().offset().to_string();
    Some((
        format!("{}{}", start.format("%Y-%m-%dT%H:%M:%S"), tz),
        format!("{}{}", end.format("%Y-%m-%dT%H:%M:%S"), tz),
    ))
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
