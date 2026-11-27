const imageLimit = 10;
const videoLimit = 500;
export const singleUploadMaxBytes = 50 * 1024 * 1024;
export const uploadPartBytes = 16 * 1024 * 1024;
const types = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

export const mediaAccept = [...new Set(Object.values(types))]
  .concat(Object.keys(types).map((extension) => "." + extension)).join(",");
export const mediaLimitsLabel = "图片最多 " + imageLimit + " MB，视频最多 " + videoLimit + " MB。";
const allowedTypes = new Set(Object.values(types));

export function fileMediaType(file) {
  const type = file.type.toLowerCase();
  if (allowedTypes.has(type)) return type;
  if (type && type !== "application/octet-stream" && !/^(image|video)\//.test(type)) return "";
  const extension = /\.([a-z\d]+)$/i.exec(file.name)?.[1].toLowerCase();
  return extension && Object.hasOwn(types, extension) ? types[extension] : "";
}

export function mediaMaxBytes(type) {
  if (!allowedTypes.has(type)) return 0;
  return (type.startsWith("image/") ? imageLimit : videoLimit) * 1024 * 1024;
}
