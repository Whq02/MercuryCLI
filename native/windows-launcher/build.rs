use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    for path in [
        "policy.mjs",
        "../../package.json",
        "../../scripts/release/launcherTemplates.mjs",
        "../../src/main.tsx",
        "../../src/entrypoints/cli.tsx",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    let output = Command::new("node")
        .arg("policy.mjs")
        .output()
        .expect("Node is required to read the launcher's policy");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("policy.rs"),
        output.stdout,
    )
    .unwrap();
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg-bin=mercury=/Brepro");
    }
}
