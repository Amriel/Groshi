use serde_json::json;

// Звичайний HTML не відтворює nonce, який Tauri додає під час віддачі
// вбудованих ресурсів. Беремо ті самі байти й CSP через справжній resolver,
// але без запуску вікон, сховища, команд, плагінів Грошей чи основного setup.
#[test]
fn compiled_assets_preserve_ui_styles() {
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    let app = tauri::test::mock_builder().build(context).unwrap();
    let resolver = app.asset_resolver();
    let asset = resolver.get_for_scheme("index.html".into(), false).unwrap();
    let html = String::from_utf8(asset.bytes).unwrap();
    let csp = asset.csp_header.expect("Вбудований HTML мусить мати CSP");

    let directive = |name: &str| -> Vec<&str> {
        csp.split(';').find_map(|part| {
            let mut sources = part.split_whitespace();
            (sources.next() == Some(name)).then(|| sources.collect())
        }).unwrap_or_default()
    };
    assert_eq!(directive("style-src-attr"), vec!["'unsafe-inline'"],
        "Nonce у style-src блокує атрибути style без окремого style-src-attr");
    assert!(directive("style-src").iter().any(|source| source.starts_with("'nonce-")),
        "Проба повинна перевіряти CSP після обробки Tauri");
    assert!(!html.contains("__TAURI_STYLE_NONCE__"));
    assert!(!html.contains("__TAURI_SCRIPT_NONCE__"));
    assert!(directive("script-src").contains(&"'self'"));
    assert!(!directive("script-src").contains(&"'unsafe-inline'"));
    assert!(!directive("script-src").contains(&"'unsafe-eval'"));
    assert_eq!(directive("default-src"), vec!["'none'"]);
    assert_eq!(directive("connect-src"), vec!["ipc:", "http://ipc.localhost", "https://ipc.localhost"]);

    // Артефакт створюємо лише на явний запит CI/локальної браузерної проби.
    // Звичайний cargo test нічого не записує у теку даних користувача.
    if let Some(output) = std::env::var_os("GROSHI_CSP_FIXTURE") {
        let mut assets = serde_json::Map::new();
        for name in ["desktop.js", "app.js", "mononorm.js", "invnorm.js"] {
            let asset = resolver.get_for_scheme(name.into(), false).unwrap();
            assert!(asset.csp_header.is_none());
            assert!(asset.mime_type.contains("javascript"));
            assets.insert(name.into(), json!({
                "body": String::from_utf8(asset.bytes).unwrap(),
                "mimeType": asset.mime_type,
            }));
        }
        let path = std::path::PathBuf::from(output);
        assert!(path.is_absolute(), "GROSHI_CSP_FIXTURE має бути абсолютним шляхом");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let fixture = json!({"html": html, "csp": csp, "assets": assets,
            "version": env!("CARGO_PKG_VERSION")});
        std::fs::write(path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    }
}
