export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { verifyChallenge, cleanupExpiredChallenges } from "@/lib/auth/challenge";
import { normalizeWalletAddress } from "@/lib/api/validation";
import { withApiHardening } from "@/lib/api/hardening";
import { getDb } from "@/lib/mongodb";
import { auditLog } from "@/lib/api/audit";

export async function POST(request) {
  return withApiHardening(
    request,
    { route: "auth-verify", rateLimit: { limit: 20, windowMs: 60_000 } },
    async () => {
      try {
        const body = await request.json();
        const address = normalizeWalletAddress(body?.address);
        const nonce = typeof body?.nonce === "string" ? body.nonce.trim() : "";
        const signedTransactionXdr = typeof body?.signedTransactionXdr === "string" ? body.signedTransactionXdr.trim() : "";

        if (!address || !nonce || !signedTransactionXdr) {
          return NextResponse.json(
            { error: "Missing required fields: address, nonce, signedTransactionXdr" },
            { status: 400 }
          );
        }

        const result = await verifyChallenge(address, nonce, signedTransactionXdr);

        if (!result.valid) {
          auditLog({
            event: "auth_verify_failed",
            route: "auth/verify",
            method: "POST",
            status: 401,
            reason: result.reason,
            address,
          });
          return NextResponse.json({ error: result.reason }, { status: 401 });
        }

        cleanupExpiredChallenges().catch(() => {});

        const db = await getDb();
        const users = db.collection("users");
        const user = await users.findOne({
          $or: [
            { walletAddress: address },
            { walletAddressLower: address.toLowerCase() },
          ],
        });

        const secret = process.env.JWT_SECRET;
        if (!secret) {
          return NextResponse.json({ error: "Server configuration error" }, { status: 500 });
        }

        const tokenPayload = {
          sub: user?._id?.toString() ?? address,
          email: user?.email ?? "",
          name: user?.fullName ?? "",
          walletAddress: address,
        };
        const token = jwt.sign(tokenPayload, secret, { expiresIn: "7d" });

        const response = NextResponse.json({
          success: true,
          user: user || null,
          isNewUser: !user,
        });

        response.cookies.set("auth_token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24 * 7,
        });

        auditLog({
          event: "auth_verify_success",
          route: "auth/verify",
          method: "POST",
          status: 200,
          address,
        });

        return response;
      } catch (error) {
        auditLog({
          event: "auth_verify_error",
          route: "auth/verify",
          method: "POST",
          status: 500,
          reason: error.message,
        });
        return NextResponse.json({ error: "Server error" }, { status: 500 });
      }
    }
  );
}
