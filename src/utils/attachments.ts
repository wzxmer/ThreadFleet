export type ParsedAttachedFile = {
  name: string;
  source?: string;
};

const imageExtensions = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i;

function decodeAttachmentName(value: string) {
  const unquoted = value.trim().replace(/^"|"$/g, "");
  try {
    return decodeURIComponent(unquoted);
  } catch {
    return unquoted;
  }
}

function dataUrlMeta(path: string) {
  if (!path.startsWith("data:")) {
    return null;
  }
  const commaIndex = path.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  return path.slice("data:".length, commaIndex);
}

export function attachmentNameFromDataUrl(path: string) {
  const meta = dataUrlMeta(path);
  if (!meta) {
    return "";
  }
  const part = meta.split(";").find((entry) => entry.startsWith("name="));
  return part ? decodeAttachmentName(part.slice("name=".length)) : "";
}

export function attachmentDisplayName(path: string) {
  const dataUrlName = attachmentNameFromDataUrl(path);
  if (dataUrlName) {
    return dataUrlName;
  }
  if (path.startsWith("data:image/")) {
    return "粘贴的图片";
  }
  if (path.startsWith("data:")) {
    return "粘贴的附件";
  }
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return "图片";
  }
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.length ? parts[parts.length - 1] : path;
  const generatedImageMatch = fileName.match(
    /^image-(\d{8})-(\d{6})(?:\.\d+)?-[0-9a-f-]+(\.[a-z0-9]+)$/i,
  );
  if (generatedImageMatch) {
    const time = generatedImageMatch[2];
    return `image-${time.slice(0, 2)}${time.slice(2, 4)}${time.slice(4, 6)}${generatedImageMatch[3]}`;
  }
  return fileName;
}

export function isImageAttachment(path: string) {
  if (path.startsWith("data:image/")) {
    return true;
  }
  if (path.startsWith("data:")) {
    return false;
  }
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return true;
  }
  return imageExtensions.test(path);
}

export function splitImageAndFileAttachments(paths: string[] = []) {
  const images: string[] = [];
  const attachments: string[] = [];
  paths.forEach((path) => {
    if (isImageAttachment(path)) {
      images.push(path);
    } else {
      attachments.push(path);
    }
  });
  return { images, attachments };
}

function decodeAttachedFileName(value: string) {
  return value.replace(/&quot;/g, "\"").trim();
}

export function extractAttachedFilesFromText(text: string): {
  text: string;
  attachments: ParsedAttachedFile[];
} {
  const attachments: ParsedAttachedFile[] = [];
  const nextText = text.replace(
    /<(attached_file|content_reference)\b([^>]*)>[\s\S]*?<\/\1>/g,
    (_match, tagName: string, attrs: string) => {
      const nameAttribute =
        tagName === "content_reference" ? "source_name" : "name";
      const nameMatch = String(attrs).match(
        new RegExp(`\\b${nameAttribute}="([^"]*)"`),
      );
      const fallbackName =
        tagName === "content_reference" ? "referenced-content" : "pasted-file";
      const name = nameMatch?.[1]
        ? decodeAttachedFileName(nameMatch[1])
        : fallbackName;
      attachments.push({ name });
      return "";
    },
  );
  return {
    text: nextText.replace(/\n{3,}/g, "\n\n").trim(),
    attachments,
  };
}

export function decodeTextAttachmentDataUrl(path: string) {
  if (!path.startsWith("data:text/")) {
    return null;
  }
  const commaIndex = path.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const meta = path.slice(0, commaIndex);
  const payload = path.slice(commaIndex + 1);
  try {
    const text = meta.includes(";base64")
      ? new TextDecoder().decode(
          Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)),
        )
      : decodeURIComponent(payload);
    return {
      name: attachmentNameFromDataUrl(path) || "pasted-text.txt",
      text,
    };
  } catch {
    return null;
  }
}
export function withFileNameInDataUrl(dataUrl: string, fileName: string) {
  if (!dataUrl.startsWith("data:") || !fileName.trim()) {
    return dataUrl;
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return dataUrl;
  }
  const meta = dataUrl.slice(0, commaIndex);
  if (meta.includes(";name=")) {
    return dataUrl;
  }
  const safeName = encodeURIComponent(fileName.trim());
  if (meta.endsWith(";base64")) {
    return `${meta.slice(0, -";base64".length)};name="${safeName}";base64${dataUrl.slice(commaIndex)}`;
  }
  return `${meta};name="${safeName}"${dataUrl.slice(commaIndex)}`;
}
