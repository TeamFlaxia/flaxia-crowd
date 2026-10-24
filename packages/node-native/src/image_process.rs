use base64::{Engine, engine::general_purpose::STANDARD};
use image::{
    DynamicImage, ImageFormat, ImageReader,
    codecs::{jpeg::JpegEncoder, png::PngEncoder, webp::WebPEncoder},
    imageops::FilterType,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Cursor, Write};

pub const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_TASK_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
// Leave room for base64 expansion and the result's JSON envelope.
const MAX_ENCODED_BYTES: usize = 3 * 1024 * 1024 - 4096;
const MAX_SIDE: u32 = 8192;
const MAX_PIXELS: u64 = 32 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    operation: Operation,
    image_base64: String,
    mime_type: String,
    options: Options,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    Resize,
    Grayscale,
    Compress,
    Thumbnail,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    width: Option<u32>,
    height: Option<u32>,
    quality: Option<f32>,
    output_format: Option<String>,
}

struct BoundedOutput(Vec<u8>);
impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_ENCODED_BYTES {
            return Err(std::io::Error::other("output exceeds result budget"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), &'static str> {
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err("IMAGE_DIMENSIONS_EXCEEDED");
    }
    Ok(())
}

fn requested_side(value: Option<u32>, source: u32) -> Result<u32, &'static str> {
    match value {
        Some(0) => Err("INVALID_IMAGE_SIZE"),
        Some(side) if side > MAX_SIDE => Err("IMAGE_DIMENSIONS_EXCEEDED"),
        Some(side) => Ok(side.min(source)),
        None => Ok(source),
    }
}

fn mime(format: ImageFormat) -> Result<&'static str, &'static str> {
    match format {
        ImageFormat::Png => Ok("image/png"),
        ImageFormat::Jpeg => Ok("image/jpeg"),
        ImageFormat::WebP => Ok("image/webp"),
        _ => Err("UNSUPPORTED_IMAGE_FORMAT"),
    }
}

/// Processes only inline bytes. No URL fetching or filesystem input is accepted.
/// Called inside the limited child process, never the signaling runtime.
pub fn process(value: Value) -> Result<Value, &'static str> {
    let payload: Payload = serde_json::from_value(value).map_err(|_| "INVALID_IMAGE_PAYLOAD")?;
    if payload.image_base64.len() > MAX_INPUT_BYTES.div_ceil(3) * 4 {
        return Err("IMAGE_INPUT_TOO_LARGE");
    }
    let bytes = STANDARD
        .decode(&payload.image_base64)
        .map_err(|_| "INVALID_IMAGE_BASE64")?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("IMAGE_INPUT_TOO_LARGE");
    }
    let format = image::guess_format(&bytes).map_err(|_| "INVALID_IMAGE_HEADER")?;
    if mime(format)? != payload.mime_type {
        return Err("IMAGE_MIME_MISMATCH");
    }
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits.clone());
    let (source_width, source_height) = reader
        .into_dimensions()
        .map_err(|_| "INVALID_IMAGE_HEADER")?;
    validate_dimensions(source_width, source_height)?;
    let width = requested_side(payload.options.width, source_width)?;
    let height = requested_side(payload.options.height, source_height)?;
    validate_dimensions(width, height)?;
    let quality = payload.options.quality.unwrap_or(0.8);
    if !quality.is_finite() || !(0.0..=1.0).contains(&quality) {
        return Err("INVALID_IMAGE_QUALITY");
    }
    let output_format = match payload.options.output_format.as_deref() {
        Some("png") => ImageFormat::Png,
        Some("jpeg") => ImageFormat::Jpeg,
        Some("webp") => ImageFormat::WebP,
        Some(_) => return Err("UNSUPPORTED_IMAGE_FORMAT"),
        None => format,
    };
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    reader.limits(limits);
    let mut decoded = reader.decode().map_err(|_| "IMAGE_DECODE_FAILED")?;
    if decoded.width() != source_width || decoded.height() != source_height {
        return Err("IMAGE_DIMENSIONS_MISMATCH");
    }
    if decoded.width() != width || decoded.height() != height {
        decoded = decoded.resize_exact(width, height, FilterType::Triangle);
    }
    if matches!(payload.operation, Operation::Grayscale) {
        decoded = decoded.grayscale();
    }
    encode(decoded, output_format, quality, bytes.len())
}

fn encode(
    decoded: DynamicImage,
    format: ImageFormat,
    quality: f32,
    original_bytes: usize,
) -> Result<Value, &'static str> {
    let mut output = BoundedOutput(Vec::new());
    match format {
        ImageFormat::Jpeg => {
            let rgb = decoded.to_rgb8();
            // Canvas treats quality 0 as its existing default (options.quality || 0.8).
            let quality = if quality == 0.0 { 0.8 } else { quality };
            JpegEncoder::new_with_quality(&mut output, (quality * 100.0).round().max(1.0) as u8)
                .encode_image(&rgb)
                .map_err(|_| "IMAGE_ENCODE_FAILED_OR_OUTPUT_TOO_LARGE")?;
        }
        ImageFormat::Png => decoded
            .write_with_encoder(PngEncoder::new(&mut output))
            .map_err(|_| "IMAGE_ENCODE_FAILED_OR_OUTPUT_TOO_LARGE")?,
        ImageFormat::WebP => decoded
            .write_with_encoder(WebPEncoder::new_lossless(&mut output))
            .map_err(|_| "IMAGE_ENCODE_FAILED_OR_OUTPUT_TOO_LARGE")?,
        _ => return Err("UNSUPPORTED_IMAGE_FORMAT"),
    }
    Ok(json!({
        "imageBase64": STANDARD.encode(&output.0),
        "mimeType": mime(format)?,
        "originalSizeBytes": original_bytes,
        "resultSizeBytes": output.0.len()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Value {
        let image = image::RgbImage::from_pixel(4, 3, image::Rgb([180, 80, 10]));
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        json!({"operation":"resize", "imageBase64":STANDARD.encode(bytes.into_inner()), "mimeType":"image/png", "options":{"width":2,"height":2}})
    }
    #[test]
    fn resize_grayscale_and_all_formats_return_valid_sdk_results() {
        for operation in ["resize", "grayscale", "compress", "thumbnail"] {
            for format in ["png", "jpeg", "webp"] {
                let mut input = payload();
                input["operation"] = json!(operation);
                input["options"]["outputFormat"] = json!(format);
                let result = process(input.clone()).unwrap();
                let bytes = STANDARD
                    .decode(result["imageBase64"].as_str().unwrap())
                    .unwrap();
                assert_eq!(result["resultSizeBytes"], bytes.len());
                assert_eq!(
                    result["originalSizeBytes"],
                    STANDARD
                        .decode(input["imageBase64"].as_str().unwrap())
                        .unwrap()
                        .len()
                );
                let image = image::load_from_memory(&bytes).unwrap();
                assert_eq!((image.width(), image.height()), (2, 2));
                if operation == "grayscale" {
                    let pixel = image.to_rgb8().get_pixel(0, 0).0;
                    assert!(pixel[0].abs_diff(pixel[1]) <= 1 && pixel[1].abs_diff(pixel[2]) <= 1);
                }
            }
        }
    }
    #[test]
    fn refuses_bad_inputs_and_never_upscales() {
        for (field, value) in [
            ("width", json!(0)),
            ("width", json!(8193)),
            ("height", json!(-1)),
            ("quality", json!(1.1)),
            ("outputFormat", json!("gif")),
        ] {
            let mut input = payload();
            input["options"][field] = value;
            assert!(process(input).is_err());
        }
        let mut input = payload();
        input["options"] = json!({"width":8,"height":8});
        let output = process(input).unwrap();
        let image = image::load_from_memory(
            &STANDARD
                .decode(output["imageBase64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!((image.width(), image.height()), (4, 3));
        let mut input = payload();
        input["mimeType"] = json!("image/jpeg");
        assert_eq!(process(input), Err("IMAGE_MIME_MISMATCH"));
        let mut input = payload();
        input["imageBase64"] = json!("bad base64");
        assert_eq!(process(input), Err("INVALID_IMAGE_BASE64"));
        let mut input = payload();
        input["operation"] = json!("execute");
        assert_eq!(process(input), Err("INVALID_IMAGE_PAYLOAD"));
        assert!(validate_dimensions(8192, 8192).is_err());
    }
}
