/**
 * Re-exports the shared document image upload helpers (type check, size cap,
 * compression) for the documents surface.
 */
export { isDocumentImageFile, MAX_DOCUMENT_IMAGE_PROCESSING_BYTES, maybeCompressDocumentUploadImage, } from "@elizaos/shared";
