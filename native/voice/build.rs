// The Node-API link setup: napi-build supplies the platform linker
// arguments a Node addon needs (the symbols resolve inside the host Node
// at load time, never at link time).
extern crate napi_build;

fn main() {
    napi_build::setup();
}
