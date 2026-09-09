fn main() {
    // Навіть ручна збірка поза CI не має вшити фінансову історію.
    let seed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/legacy.json");
    println!("cargo:rerun-if-changed={}", seed.display());
    let data = std::fs::read_to_string(seed).expect("Не вдалося перевірити порожній seed");
    assert_eq!(data.trim(), "[]", "legacy.json має бути порожнім масивом; особисті дані не можна вшивати у збірку");
    tauri_build::build()
}
