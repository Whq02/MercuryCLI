pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "the frame is too large to encode".to_string())?;
    if rgba.len() != expected {
        return Err(format!("the frame carries {} bytes, {width}×{height} RGBA needs {expected}", rgba.len()));
    }
    if width == 0 || height == 0 {
        return Err("the frame is empty".to_string());
    }
    let mut out: Vec<u8> = Vec::with_capacity(expected / 4);
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer.write_image_data(rgba).map_err(|error| error.to_string())?;
        writer.finish().map_err(|error| error.to_string())?;
    }
    Ok(out)
}
