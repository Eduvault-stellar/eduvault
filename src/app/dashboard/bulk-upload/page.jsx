import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import BulkMaterialReview from "../components/BulkMaterialReview";

async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth_token")?.value;
  if (!token) return null;

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const payload = jwt.verify(token, secret);
    if (!payload?.sub) return null;

    const db = await getDb();
    const users = db.collection("users");
    return users.findOne({ _id: new ObjectId(payload.sub) });
  } catch {
    return null;
  }
}

export default async function BulkUploadReviewPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/");
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 lg:px-8">
      <BulkMaterialReview initialUser={user} />
    </div>
  );
}
