//! Рахунок одразу у PDF.
//!
//! НАВІЩО: раніше «Створити рахунок» давав .html, і людина мусила відкрити
//! його й сама пройти Ctrl+P → «Зберегти як PDF» — клієнту ж потрібен саме
//! PDF. WebView2 уже вміє друкувати в PDF (PrintToPdf), тож макет лишається
//! один — той самий invoiceHtml(), текст у PDF справжній (копіюється, кирилиця
//! без вбудовування шрифтів), а сторонньої JS-бібліотеки, що малює картинкою,
//! не потрібно.
//!
//! Рахунок вантажиться в окреме приховане вікно з тимчасового файла: мітки
//! цього вікна немає в жодних capabilities, тож у нього немає IPC, а CSP
//! усередині самого рахунку забороняє скрипти й мережу.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Manager};

static SEQ: AtomicU32 = AtomicU32::new(0);

type Done = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>>;

fn finish(done: &Done, result: Result<(), String>) {
    if let Some(tx) = done.lock().ok().and_then(|mut g| g.take()) {
        let _ = tx.send(result);
    }
}

#[tauri::command]
pub async fn save_pdf(app: AppHandle, name: String, html: String) -> Result<String, String> {
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("тека «Завантаження»: {e}"))?;
    let out = crate::safety::reserve_pdf(&dir, &name)?;
    let result = render(&app, &html, &out).await;
    if let Err(e) = result {
        // Порожній зарезервований файл не повинен лишатися як «рахунок».
        let _ = std::fs::remove_file(&out);
        return Err(e);
    }
    Ok(out.to_string_lossy().to_string())
}

pub(crate) async fn render(app: &AppHandle, html: &str, out: &std::path::Path) -> Result<(), String> {
    // NavigateToString обмежений 2 МБ, а підпис-картинка в data-URL туди
    // не завжди влазить — тому файл, а не рядок.
    let tmp = tempfile::Builder::new()
        .prefix("groshi-invoice-")
        .suffix(".html")
        .tempfile()
        .map_err(|e| e.to_string())?;
    std::fs::write(tmp.path(), html).map_err(|e| e.to_string())?;
    let url = tauri::Url::from_file_path(tmp.path()).map_err(|_| "шлях тимчасового файла".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let done: Done = Arc::new(Mutex::new(Some(tx)));
    let label = format!("pdf-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let target = out.to_path_buf();
    let on_load = done.clone();

    let win = tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
        .title("PDF")
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .on_page_load(move |w, p| {
            if p.event() != tauri::webview::PageLoadEvent::Finished { return; }
            let done = on_load.clone();
            let target = target.clone();
            let sent = w.with_webview(move |pw| print(pw, &target, done.clone()));
            if let Err(e) = sent { finish(&on_load, Err(e.to_string())); }
        })
        .build()
        .map_err(|e| format!("вікно для PDF: {e}"))?;

    let res = tokio::time::timeout(Duration::from_secs(30), rx).await;
    let _ = win.destroy();
    drop(tmp);
    match res {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("друк у PDF обірвався".into()),
        Err(_) => Err("друк у PDF не встиг за 30 с".into()),
    }
}

#[cfg(windows)]
fn print(pw: tauri::webview::PlatformWebview, out: &std::path::Path, done: Done) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING, PCWSTR};

    let fail = done.clone();
    let run = || -> windows_core::Result<()> {
        unsafe {
            let core: ICoreWebView2_7 = pw.controller().CoreWebView2()?.cast()?;
            let env: ICoreWebView2Environment6 = pw.environment().cast()?;
            let s = env.CreatePrintSettings()?;
            // A4 у дюймах; поля = 12 мм, як @page у самому рахунку.
            s.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
            s.SetPageWidth(8.27)?;
            s.SetPageHeight(11.69)?;
            s.SetMarginTop(0.47)?;
            s.SetMarginBottom(0.47)?;
            s.SetMarginLeft(0.47)?;
            s.SetMarginRight(0.47)?;
            // Темна шапка таблиці й жовтий рядок «До сплати» — це фон;
            // без цього прапорця вони зникають.
            s.SetShouldPrintBackgrounds(true)?;
            s.SetShouldPrintHeaderAndFooter(false)?;
            let path = HSTRING::from(out.as_os_str());
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                let r = match (hr, ok) {
                    (Ok(()), true) => Ok(()),
                    (Err(e), _) => Err(format!("WebView2: {e}")),
                    (Ok(()), false) => Err("WebView2 не зміг записати PDF".into()),
                };
                finish(&done, r);
                Ok(())
            }));
            core.PrintToPdf(PCWSTR(path.as_ptr()), &s, &handler)
        }
    };
    if let Err(e) = run() {
        finish(&fail, Err(format!("WebView2: {e}")));
    }
}

#[cfg(not(windows))]
fn print(_pw: tauri::webview::PlatformWebview, _out: &std::path::Path, done: Done) {
    // На macOS PDF поки немає — апка лишає .html, як раніше.
    finish(&done, Err("PDF доступний лише у Windows".into()));
}
