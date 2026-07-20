import { NextResponse } from "next/server";

import { auditLog } from "@/lib/api/audit";
import { withApiHardening } from "@/lib/api/hardening";
import {
  normalizeStringList,
  sanitizeObject,
  validateUploadFileMetadata,
  validateUploadPayload,
} from "@/lib/api/validation";
import {
  retryWithBackoff,
  validateGatewayUrl,
  validatePinataResponse,
} from "@/lib/api/storage";
import { getDb } from "@/lib/mongodb";
import { pinata } from "@/lib/pinata";
import { storeManifest } from "@/lib/provenance/registry";
import { hashFileBytes } from "@/lib/provenance/manifest";
import { validateUploadedFile } from "@/lib/ipfs/uploadValidator";
import { quarantineUpload } from "@/lib/uploads/quarantine";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_SIZE_BYTES = 5 * 1024 * 1024;

const ALLOWED_FILE_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "application/zip",
  "application/x-zip-compressed",
];

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

function createUploadErrorResponse({
  error,
  status,
  reason,
}) {
  auditLog({
    event: "upload_failed",
    route: "upload",
    method: "POST",
    status,
    reason,
  });

  return NextResponse.json(
    { error },
    { status },
  );
}

function collectOtherFields(form) {
  const fields = {};

  for (const [key, value] of form.entries()) {
    if (key !== "file" && key !== "thumbnail") {
      fields[key] = value;
    }
  }

  return fields;
}

async function savePendingUpload({
  request,
  originalError,
}) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const image = form.get("thumbnail");

    if (!file) {
      throw new Error(
        "No document file is available for fallback storage.",
      );
    }

    const fileBuffer = Buffer.from(
      await file.arrayBuffer(),
    );

    const imageBuffer = image
      ? Buffer.from(await image.arrayBuffer())
      : null;

    const db = await getDb();

    await db.collection("pending_pins").insertOne({
      status: "pending",
      createdAt: new Date(),
      lastError:
        originalError?.message ||
        "Unknown storage error",
      fileData: fileBuffer,
      fileType: file.type || null,
      fileName: file.name || null,
      imageData: imageBuffer,
      imageType: image?.type || null,
      imageName: image?.name || null,
      otherFields: collectOtherFields(form),
    });

    auditLog({
      event: "upload_queued",
      route: "upload",
      method: "POST",
      status: 202,
      reason: "storage_temporarily_unavailable",
    });

    return NextResponse.json(
      {
        success: true,
        status: "pending",
        message:
          "Upload queued due to temporary storage issues.",
      },
      {
        status: 202,
      },
    );
  } catch (fallbackError) {
    console.error(
      "[Upload] Failed to persist pending upload:",
      fallbackError,
    );

    return createUploadErrorResponse({
      error:
        originalError?.message ||
        "Upload failed",
      status: 500,
      reason:
        fallbackError?.message ||
        "pending_upload_persistence_failed",
    });
  }
}

async function uploadPublicFile({
  file,
  label,
}) {
  const uploaded = await retryWithBackoff(
    () => pinata.upload.public.file(file),
    3,
    1000,
    (error, attempt) => {
      console.warn(
        `[Storage] ${label} upload attempt ${attempt} failed: ${error.message}`,
      );
    },
  );

  validatePinataResponse(uploaded, label);

  const url = await retryWithBackoff(
    () =>
      pinata.gateways.public.convert(
        uploaded.cid,
      ),
    3,
    1000,
    (error, attempt) => {
      console.warn(
        `[Storage] ${label} gateway attempt ${attempt} failed: ${error.message}`,
      );
    },
  );

  validateGatewayUrl(url, label);

  return {
    cid: uploaded.cid,
    url,
  };
}

async function uploadMetadata(metadata) {
  const uploaded = await retryWithBackoff(
    () => pinata.upload.public.json(metadata),
    3,
    1000,
    (error, attempt) => {
      console.warn(
        `[Storage] Metadata upload attempt ${attempt} failed: ${error.message}`,
      );
    },
  );

  validatePinataResponse(
    uploaded,
    "metadata",
  );

  const url = await retryWithBackoff(
    () =>
      pinata.gateways.public.convert(
        uploaded.cid,
      ),
    3,
    1000,
    (error, attempt) => {
      console.warn(
        `[Storage] Metadata gateway attempt ${attempt} failed: ${error.message}`,
      );
    },
  );

  validateGatewayUrl(url, "metadata");

  return {
    cid: uploaded.cid,
    url,
  };
}

export async function POST(request) {
  const fallbackRequest = request.clone();

  return withApiHardening(
    request,
    {
      route: "upload",
      rateLimit: {
        limit: 20,
        windowMs: 60_000,
      },
    },
    async () => {
      try {
        const form = await request.formData();
        const file = form.get("file");
        const image = form.get("thumbnail");

        if (!file) {
          return createUploadErrorResponse({
            error:
              "No document file provided.",
            status: 400,
            reason: "missing_file",
          });
        }

        if (
          file.size >
          MAX_FILE_SIZE_BYTES
        ) {
          const sizeMB = (
            file.size /
            (1024 * 1024)
          ).toFixed(2);

          return createUploadErrorResponse({
            error: `File size (${sizeMB}MB) exceeds the 10MB limit.`,
            status: 413,
            reason: "file_too_large",
          });
        }

        if (
          !ALLOWED_FILE_TYPES.includes(
            file.type,
          )
        ) {
          return createUploadErrorResponse({
            error:
              `Unsupported file type: ${
                file.type || "unknown"
              }. Allowed types include PDF, Word, Excel, PPT, TXT, and ZIP.`,
            status: 415,
            reason:
              "unsupported_file_type",
          });
        }

        if (image) {
          if (
            image.size >
            MAX_THUMBNAIL_SIZE_BYTES
          ) {
            const sizeMB = (
              image.size /
              (1024 * 1024)
            ).toFixed(2);

            return createUploadErrorResponse({
              error: `Thumbnail size (${sizeMB}MB) exceeds the 5MB limit.`,
              status: 413,
              reason:
                "thumbnail_too_large",
            });
          }

          if (
            !ALLOWED_IMAGE_TYPES.includes(
              image.type,
            )
          ) {
            return createUploadErrorResponse({
              error:
                `Unsupported thumbnail type: ${
                  image.type || "unknown"
                }. Allowed types are JPG, PNG, and WEBP.`,
              status: 415,
              reason:
                "unsupported_thumbnail_type",
            });
          }
        }

        try {
          validateUploadFileMetadata(
            file,
            "file",
          );
        } catch (validationError) {
          return createUploadErrorResponse({
            error:
              validationError.message,
            status: 400,
            reason:
              validationError.message,
          });
        }

        const byteValidation = await validateUploadedFile(file, ALLOWED_FILE_TYPES);
        if (!byteValidation.valid) {
          return createUploadErrorResponse({ error: byteValidation.reason, status: 415, reason: "content_type_mismatch" });
        }

        const fileBuffer = Buffer.from(await file.arrayBuffer());
        const db = await getDb();
        const quarantined = await quarantineUpload(db, {
          bytes: fileBuffer, fileName: file.name, mimeType: file.type,
          metadata: { title: form.get("title") || form.get("name") },
        });
        if (quarantined.status !== "approved") {
          return NextResponse.json(
            { success: true, uploadId: String(quarantined._id), status: quarantined.status },
            { status: 202, headers: { "Cache-Control": "no-store" } },
          );
        }

        const metadataPayload = {
          title:
            form.get("title") ||
            form.get("name"),
          description:
            form.get("description"),
          price: form.get("price"),
          usageRights:
            form.get("usageRights"),
          visibility:
            form.get("visibility"),
        };

        try {
          validateUploadPayload(
            metadataPayload,
          );
        } catch (validationError) {
          return createUploadErrorResponse({
            error:
              validationError.message,
            status: 400,
            reason:
              validationError.message,
          });
        }

        const uploadedDocument =
          await uploadPublicFile({
            file,
            label: "document",
          });

        // Publication is performed by the scan worker only after approval.
        const fileHash = hashFileBytes(fileBuffer);

        let uploadedThumbnail = null;

        if (image) {
          uploadedThumbnail =
            await uploadPublicFile({
              file: image,
              label: "thumbnail",
            });
        }

        const otherFields =
          collectOtherFields(form);

        const previewInputs = {
          learningOutcomes:
            otherFields.learningOutcomes,
          tableOfContents:
            otherFields.tableOfContents,
          sampleNotes:
            otherFields.sampleNotes,
        };

        const scalarFields = {
          ...otherFields,
        };

        delete scalarFields.learningOutcomes;
        delete scalarFields.tableOfContents;
        delete scalarFields.sampleNotes;

        const sanitizedScalarFields =
          sanitizeObject(
            scalarFields,
            {
              title: 160,
              description: 5000,
              shortSummary: 280,
              usageRights: 1000,
              coverImageUrl: 2048,
              thumbnailUrl: 2048,
            },
          );

        const imageUrl =
          uploadedThumbnail?.url || null;

        const metadataJSON = {
          ...sanitizedScalarFields,
          coverImageUrl:
            imageUrl ||
            sanitizedScalarFields.coverImageUrl ||
            null,
          thumbnailUrl:
            imageUrl ||
            sanitizedScalarFields.thumbnailUrl ||
            null,
          learningOutcomes:
            normalizeStringList(
              previewInputs.learningOutcomes,
              {
                maxItems: 8,
                maxLength: 180,
              },
            ),
          tableOfContents:
            normalizeStringList(
              previewInputs.tableOfContents,
              {
                maxItems: 16,
                maxLength: 180,
              },
            ),
          sampleNotes:
            normalizeStringList(
              previewInputs.sampleNotes,
              {
                maxItems: 6,
                maxLength: 280,
              },
            ),
          storageKey:
            uploadedDocument.cid,
          fileUrl:
            uploadedDocument.url,
          image: imageUrl,
          timestamp:
            new Date().toISOString(),
        };

        auditLog({
          event:
            "upload_metadata_prepared",
          route: "upload",
          method: "POST",
          status: 200,
        });

        const uploadedMetadata =
          await uploadMetadata(
            metadataJSON,
          );

        auditLog({
          event: "upload_complete",
          route: "upload",
          method: "POST",
          status: 200,
        });

        let manifestDigest = null;
        try {
          const { digest } = await storeManifest({
            materialId: uploadedDocument.cid,
            version: 1,
            previousVersionDigest: null,
            creator: otherFields.userAddress || otherFields.creatorAddress || null,
            file: {
              cid: uploadedDocument.cid,
              hash: fileHash,
              size: file.size,
              type: file.type || "application/octet-stream",
            },
            preview: uploadedThumbnail ? {
              thumbnailCid: uploadedThumbnail.cid,
            } : null,
            metadata: {
              title: metadataPayload.title,
              description: metadataPayload.description,
            },
            rights: metadataPayload.usageRights ? {
              usageRights: metadataPayload.usageRights,
            } : null,
          });
          manifestDigest = digest;
        } catch (manifestErr) {
          console.warn("[Upload] Manifest generation failed:", manifestErr?.message);
        }

        return NextResponse.json({
          success: true,
          storageKey:
            uploadedDocument.cid,
          fileUrl:
            uploadedDocument.url,
          image: imageUrl || "",
          metadata:
            uploadedMetadata.url,
          manifestDigest,
          fileHash,
        });
      } catch (error) {
        console.error(
          "[Upload] Storage upload failed:",
          error,
        );

        return savePendingUpload({
          request: fallbackRequest,
          originalError: error,
        });
      }
    },
  );
}
