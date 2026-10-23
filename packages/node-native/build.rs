use std::{env, fs, path::PathBuf};

// The SDK remains the source of truth for the handshake contract. This crate
// builds inside the monorepo; a changed TS declaration must fail the build
// rather than silently retaining an old protocol or token limit.
fn main() {
    let source = "../sdk/src/handshake.ts";
    println!("cargo:rerun-if-changed={source}");
    let ts = fs::read_to_string(source).expect("SDK handshake.ts must exist");
    let mut output = String::new();
    for (name, rust_type) in [
        ("NODE_SIGNAL_PROTOCOL", "&str"),
        ("BEARER_SUBPROTOCOL_PREFIX", "&str"),
        ("MAX_BEARER_TOKEN_CHARS", "usize"),
    ] {
        let prefix = format!("export const {name} = ");
        let value = ts
            .lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .and_then(|line| line.strip_suffix(';'))
            .expect("SDK handshake constant declaration changed");
        let literal = if rust_type == "&str" {
            let text = value
                .strip_prefix('\'')
                .and_then(|s| s.strip_suffix('\''))
                .expect("expected SDK string literal");
            assert!(
                text.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-._".contains(c))
            );
            format!("{text:?}")
        } else {
            value
                .parse::<usize>()
                .expect("expected SDK integer literal")
                .to_string()
        };
        output.push_str(&format!("pub const {name}: {rust_type} = {literal};\n"));
    }
    let destination = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("protocol.rs");
    fs::write(destination, output).unwrap();
}
