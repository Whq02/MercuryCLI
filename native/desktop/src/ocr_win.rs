use windows::Data::Pdf::PdfDocument;
use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, BitmapAlphaMode, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

pub fn languages() -> Result<Vec<String>, String> {
    std::thread::spawn(|| {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
        let result = (|| -> windows::core::Result<Vec<String>> {
            let installed = OcrEngine::AvailableRecognizerLanguages()?;
            let mut result = Vec::new();
            for i in 0..installed.Size()? { result.push(installed.GetAt(i)?.LanguageTag()?.to_string()); }
            Ok(result)
        })();
        unsafe { RoUninitialize() };
        result.map_err(|e| e.to_string())
    }).join().map_err(|_| "Windows OCR language lookup failed".to_string())?
}

pub fn recognise(bytes: &[u8], page: Option<u32>) -> Result<String, String> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
    let result = recognise_inner(bytes, page).map_err(|e| e.to_string());
    unsafe { RoUninitialize() };
    result
}
fn recognise_inner(bytes: &[u8], page: Option<u32>) -> windows::core::Result<String> {
    let input = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&input)?;
    writer.WriteBytes(bytes)?;
    writer.StoreAsync()?.get()?;
    writer.DetachStream()?;
    input.Seek(0)?;
    let source = if let Some(number) = page {
        let pdf = PdfDocument::LoadFromStreamAsync(&input)?.get()?;
        if number == 0 || number > pdf.PageCount()? { return Err(windows::core::Error::from_hresult(windows::Win32::Foundation::E_INVALIDARG)); }
        let image = InMemoryRandomAccessStream::new()?;
        let page = pdf.GetPage(number - 1)?;
        page.RenderToStreamAsync(&image)?.get()?;
        image.Seek(0)?;
        image
    } else { input };
    let decoder = BitmapDecoder::CreateAsync(&source)?.get()?;
    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
    let image = SoftwareBitmap::ConvertWithAlpha(&bitmap, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied)?;
    let installed = OcrEngine::AvailableRecognizerLanguages()?;
    let mut outputs: Vec<(String, String)> = Vec::new();
    for i in 0..installed.Size()? {
        let language = installed.GetAt(i)?;
        let engine = OcrEngine::TryCreateFromLanguage(&language)?;
        let result = engine.RecognizeAsync(&image)?.get()?;
        let lines = result.Lines()?;
        let mut text = Vec::new();
        for j in 0..lines.Size()? { text.push(lines.GetAt(j)?.Text()?.to_string()); }
        let body = text.join("\n");
        if !body.is_empty() && !outputs.iter().any(|(_, value)| value == &body) { outputs.push((language.LanguageTag()?.to_string(), body)); }
    }
    if outputs.len() == 1 { return Ok(outputs.remove(0).1); }
    Ok(outputs.into_iter().map(|(language, body)| format!("[language: {language}]\n{body}")).collect::<Vec<_>>().join("\n\n"))
}
