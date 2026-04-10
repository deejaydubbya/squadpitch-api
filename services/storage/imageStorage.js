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
      message: `Video exceeds 500 MB limit (${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`,
    };
  }
  const allowedMimes = ["video/mp4"];
  if (!allowedMimes.includes(mimeType)) {
    throw {
      status: 400,
      code: "VIDEO_INVALID_FORMAT",
      message: `Only MP4 videos are supported (got ${mimeType})`,
    };
  }
  if (buffer.length >= 8) {
    const magic = buffer.toString("ascii", 4, 8);
    if (magic !== "ftyp") {
      throw {
        status: 400,
        code: "VIDEO_INVALID_FORMAT",
        message: "File does not appear to be a valid MP4 (missing ftyp box)",
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
