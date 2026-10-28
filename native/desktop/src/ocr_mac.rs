use std::ptr;
use objc2::{msg_send, sel};
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSArray, NSData, NSString};

#[link(name = "Vision", kind = "framework")]
extern "C" {}
#[link(name = "PDFKit", kind = "framework")]
extern "C" {}

pub fn languages() -> Result<Vec<String>, String> {
    autoreleasepool(|_| unsafe {
        let class = AnyClass::get(c"VNRecognizeTextRequest").ok_or("macOS Vision is unavailable")?;
        let request: Retained<AnyObject> = msg_send![class, new];
        let _: () = msg_send![&*request, setRecognitionLevel: 0isize];
        let mut error: *mut AnyObject = ptr::null_mut();
        let values: *mut AnyObject = msg_send![&*request, supportedRecognitionLanguagesAndReturnError: &mut error];
        if values.is_null() || !error.is_null() { return Err("Vision recognition languages are unavailable".to_string()); }
        let count: usize = msg_send![&*values, count];
        let mut result = Vec::new();
        for i in 0..count {
            let value: Retained<NSString> = msg_send![&*values, objectAtIndex: i];
            result.push(value.to_string());
        }
        Ok(result)
    })
}

pub fn recognise(bytes: &[u8], page: Option<u32>) -> Result<String, String> {
    autoreleasepool(|_| unsafe {
        let data = NSData::with_bytes(bytes);
        let image_data: Retained<NSData> = if let Some(number) = page {
            let class = AnyClass::get(c"PDFDocument").ok_or("PDFKit is unavailable")?;
            let allocated: *mut AnyObject = msg_send![class, alloc];
            let initialised: *mut AnyObject = msg_send![allocated, initWithData: &*data];
            let document = Retained::from_raw(initialised).ok_or("The PDF could not be opened")?;
            let count: usize = msg_send![&*document, pageCount];
            if number == 0 || number as usize > count { return Err("The PDF page does not exist".to_string()); }
            let pdf_page: *mut AnyObject = msg_send![&*document, pageAtIndex: number as usize - 1];
            let thumbnail: *mut AnyObject = msg_send![&*pdf_page, thumbnailOfSize: CGSize { width: 2400.0, height: 2400.0 }, forBox: 0isize];
            if thumbnail.is_null() { return Err("The PDF page could not be rendered".to_string()); }
            let rendered: Option<Retained<NSData>> = msg_send![&*thumbnail, TIFFRepresentation];
            rendered.ok_or("The PDF page has no image representation")?
        } else { data };
        let request_class = AnyClass::get(c"VNRecognizeTextRequest").ok_or("macOS Vision is unavailable")?;
        let request: Retained<AnyObject> = msg_send![request_class, new];
        let _: () = msg_send![&*request, setRecognitionLevel: 0isize];
        let _: () = msg_send![&*request, setUsesLanguageCorrection: true];
        let names: Vec<Retained<NSString>> = languages()?.iter().map(|name| NSString::from_str(name)).collect();
        let supported = NSArray::from_retained_slice(&names);
        let _: () = msg_send![&*request, setRecognitionLanguages: &*supported];
        let automatic: bool = msg_send![&*request, respondsToSelector: sel!(setAutomaticallyDetectsLanguage:)];
        if automatic { let _: () = msg_send![&*request, setAutomaticallyDetectsLanguage: true]; }
        let dictionary_class = AnyClass::get(c"NSDictionary").ok_or("Foundation is unavailable")?;
        let options: Retained<AnyObject> = msg_send![dictionary_class, new];
        let handler_class = AnyClass::get(c"VNImageRequestHandler").ok_or("macOS Vision is unavailable")?;
        let allocated: *mut AnyObject = msg_send![handler_class, alloc];
        let initialised: *mut AnyObject = msg_send![allocated, initWithData: &*image_data, options: &*options];
        let handler = Retained::from_raw(initialised).ok_or("Vision could not open the image")?;
        let array_class = AnyClass::get(c"NSArray").ok_or("Foundation is unavailable")?;
        let requests: *mut AnyObject = msg_send![array_class, arrayWithObject: &*request];
        let mut error: *mut AnyObject = ptr::null_mut();
        let success: bool = msg_send![&*handler, performRequests: &*requests, error: &mut error];
        if !success {
            let message: Option<Retained<NSString>> = if error.is_null() { None } else { msg_send![&*error, localizedDescription] };
            return Err(message.map(|s| s.to_string()).unwrap_or_else(|| "Vision text recognition failed".to_string()));
        }
        let observations: *mut AnyObject = msg_send![&*request, results];
        if observations.is_null() { return Ok(String::new()); }
        let count: usize = msg_send![&*observations, count];
        let mut lines = Vec::new();
        for i in 0..count {
            let observation: *mut AnyObject = msg_send![&*observations, objectAtIndex: i];
            let candidates: *mut AnyObject = msg_send![&*observation, topCandidates: 1usize];
            let candidate: *mut AnyObject = msg_send![&*candidates, firstObject];
            if !candidate.is_null() {
                let value: Option<Retained<NSString>> = msg_send![&*candidate, string];
                if let Some(value) = value { lines.push(value.to_string()); }
            }
        }
        Ok(lines.join("\n"))
    })
}
