import { NextResponse } from "next/server";

import { getDb } from "@/lib/mongodb";
import { getUserFromCookie } from "@/lib/api/auth";
import { withApiHardening } from "@/lib/api/hardening";
import { auditLog } from "@/lib/api/audit";
import {
  getFileForRequester,
  deleteFile,
  FileAuthorizationError,
  FileNotFoundError,
} from "@/lib/uploads/fileLifecycle";

export const dynamic = "force-dynamic";

/** Storage keys are namespaced with slashes (purpose/owner/checksum), so the
 *  route is a catch-all and the segments are re-joined here. */
async function storageKeyFrom(params) {
  const { key } = await params;
  return Array.isArray(key) ? key.join("/") : String(key || "");
}

/** The identity the lifecycle model keys ownership on. Mirrors the convention
 *  used by the other authenticated routes. */
function requesterId(user) {
  return String(user.walletAddress || user.sub || user._id);
}

function mapError(error) {
  if (error instanceof FileNotFoundError) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  if (error instanceof FileAuthorizationError) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  throw error;
}

/**
 * GET /api/files/<storage-key>
 *
 * Returns a file's metadata if the requester is allowed to see it. Public
 * objects (avatars) are readable by anyone; private objects only by their
 * owner, and a non-owner gets a 404 rather than a 403 so the object's
 * existence is not leaked.
 */
export async function GET(request, { params }) {
  return withApiHardening(request, { route: "files_get" }, async () => {
    const storageKey = await storageKeyFrom(params);
    const user = await getUserFromCookie(request);
    // An unauthenticated caller is treated as a stranger: they can still read a
    // public object but never a private one.
    const requester = user ? requesterId(user) : null;

    const db = await getDb();
    try {
      const file = await getFileForRequester(db, storageKey, requester);
      return NextResponse.json({
        storageKey: file.storageKey,
        purpose: file.purpose,
        visibility: file.visibility,
        mimeType: file.mimeType,
        size: file.size,
        checksum: file.checksum,
        state: file.state,
        createdAt: file.createdAt,
      });
    } catch (error) {
      return mapError(error);
    }
  });
}

/**
 * DELETE /api/files/<storage-key>
 *
 * Owner-scoped. Moves the file to pending_deletion and enqueues its storage
 * cleanup transactionally; the object is removed by the cleanup worker. A
 * non-owner cannot delete, and cannot tell an object they do not own from one
 * that does not exist.
 */
export async function DELETE(request, { params }) {
  return withApiHardening(request, { route: "files_delete", rateLimit: { limit: 30, windowMs: 60_000 } }, async () => {
    const storageKey = await storageKeyFrom(params);
    const user = await getUserFromCookie(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const requester = requesterId(user);

    const db = await getDb();
    try {
      const result = await deleteFile(db, { requesterId: requester, storageKey });
      auditLog({
        event: "file_deleted",
        action: "delete",
        resource: "file",
        route: "files_delete",
        method: "DELETE",
        status: 200,
        outcome: "pending_deletion",
        storageKey,
        actor: requester,
      });
      return NextResponse.json({ success: true, ...result });
    } catch (error) {
      if (error instanceof FileAuthorizationError || error instanceof FileNotFoundError) {
        auditLog({
          event: "file_delete_denied",
          action: "delete",
          resource: "file",
          route: "files_delete",
          method: "DELETE",
          status: error.status,
          outcome: error.code,
          storageKey,
          actor: requester,
        });
      }
      return mapError(error);
    }
  });
}
