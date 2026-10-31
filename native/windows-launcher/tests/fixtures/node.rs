use std::io::{self, Read};

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("-p") {
        println!("{}", std::env::var("STUB_NODE_VERSION").unwrap());
        return;
    }
    assert_eq!(std::path::Path::new(&args[0]).file_name().unwrap(), "mercury.mjs");
    for arg in &args[1..] {
        println!("arg={}", arg.as_bytes().iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    println!("stdin={input}");
    println!("cache={}", std::env::var("NODE_COMPILE_CACHE").unwrap_or_default());
    println!("cwd={}", std::env::current_dir().unwrap().display());
    eprintln!("stub stderr");
    std::process::exit(std::env::var("STUB_NODE_EXIT").unwrap().parse().unwrap());
}
