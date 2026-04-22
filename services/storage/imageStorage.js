import cloudinary from "cloudinary";

export function createImageStorageService() {
  const provider = process.env.IMAGE_STORAGE_PROVIDER || "cloudinary";
  switch (provider) {
    case "cloudinary":
      return createCloudinaryService();
    default:
      throw new Error(`Unknown image storage provider: ${provider}`);
  }
}

function createCloudinaryService() {
  const cloudinaryV2 = cloudinary.v2;
  cloudinaryV2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  return {
    async upload(buffer, options = {}) {
      return new Promise((resolve, reject) => {
        const uploadOptions = {
          folder: options.folder || "squadpitch/images",
          resource_type: "image",
          transformation: [{ quality: "auto:good" }, { fetch_format: "auto" }],
        };
        if (options.publicId) {
          uploadOptions.public_id = options.publicId;
        }
        const uploadStream = cloudinaryV2.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) reject(error);
            else
              resolve({
                url: result.secure_url,
                publicId: result.public_id,
                width: result.width,
                height: result.height,
                format: result.format,
                bytes: result.bytes,
              });
          }
        );
        uploadStream.end(buffer);
      });
    },

    async delete(publicId) {
      try {
        const result = await cloudinaryV2.uploader.destroy(publicId);
        return result.result === "ok";
      } catch (error) {
        console.error("Failed to delete image from Cloudinary:", error);
        return false;
      }
    },
  };
}

function createCloudinaryVideoService() {
  const cloudinaryV2 = cloudinary.v2;
  cloudinaryV2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  return {
    async upload(buffer, options = {}) {
      return new Promise((resolve, reject) => {
        const uploadOptions = {
          folder: options.folder || "squadpitch/videos",
          resource_type: "video",
          eager: [{ format: "jpg", start_offset: "0" }],
        };
        if (options.publicId) {
          uploadOptions.public_id = options.publicId;
        }
        const uploadStream = cloudinaryV2.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) reject(error);
            else
              resolve({
                url: result.secure_url,
                publicId: result.public_id,
                width: result.width,
                height: result.height,
                format: result.format,
                bytes: result.bytes,
                thumbnailUrl: result.eager?.[0]?.secure_url ?? null,
                durationSec:
                  result.duration != null
                    ? Math.round(result.duration)
                    : null,
              });
          }
        );
        uploadStream.end(buffer);
      });
    },

    async delete(publicId) {
      try {
        const result = await cloudinaryV2.uploader.destroy(publicId, {
          resource_type: "video",
        });
        return result.result === "ok";
      } catch (error) {
        console.error("Failed to delete video from Cloudinary:", error);
        return false;
      }
    },
  };
}

export function validateVideoBuffer(buffer, mimeType) {
  const MAX_VIDEO_SIZE = 500 * 1024 * 1024;
  if (buffer.length > MAX_VIDEO_SIZE) {
    throw {
      status: 400,
      code: "VIDEO_TOO_LARGE",
      message: `Video file is too large (${(buffer.length / (1024 * 1024)).toFixed(1)} MB). The maximum allowed size is 500 MB.`,
    };
  }
  const allowedMimes = ["video/mp4", "video/quicktime", "video/webm"];
  if (!allowedMimes.includes(mimeType)) {
    throw {
      status: 400,
      code: "VIDEO_INVALID_FORMAT",
      message: `Unsupported video format. Please upload an MP4, MOV, or WebM file.`,
    };
  }

  if (buffer.length >= 8) {
    // MP4 and MOV both use the ISO base media file format with an "ftyp" box at bytes 4-8
    const isFtyp = buffer.toString("ascii", 4, 8) === "ftyp";
    // WebM uses the EBML header starting with bytes 1A 45 DF A3
    const isEbml =
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3;

    if (!isFtyp && !isEbml) {
      throw {
        status: 400,
        code: "VIDEO_INVALID_FORMAT",
        message:
          "The file doesn't appear to be a valid video. Please upload an MP4, MOV, or WebM file.",
      };
    }
  }
}

let storageService = null;
let videoStorageService = null;

export function getImageStorageService() {
  if (!storageService) {
    storageService = createImageStorageService();
  }
  return storageService;
}

export function getVideoStorageService() {
  if (!videoStorageService) {
    videoStorageService = createCloudinaryVideoService();
  }
  return videoStorageService;
}
