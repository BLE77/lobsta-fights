import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, freshSupabase } from "../../../../../lib/supabase";
import { isAuthorizedAdminRequest } from "../../../../../lib/request-auth";

export const dynamic = "force-dynamic";

const BUCKET_NAME = "images";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

/**
 * POST /api/admin/lora/upload
 *
 * Upload training images for LoRA training.
 * Accepts multipart/form-data with image files.
 *
 * Example:
 * curl -X POST "https://clawfights.xyz/api/admin/lora/upload" \
 *   -H "x-admin-key: YOUR_KEY" \
 *   -F "images=@robot1.png" \
 *   -F "images=@robot2.png"
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedAdminRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const files = formData.getAll("images") as File[];

    if (!files || files.length === 0) {
      return NextResponse.json(
        {
          error: "No files uploaded",
          usage: "POST with multipart/form-data, field name 'images'",
          example: 'curl -X POST -H "x-admin-key: KEY" -F "images=@file1.png" -F "images=@file2.png" URL',
        },
        { status: 400 }
      );
    }

    const storageClient = supabaseAdmin || freshSupabase();
    const uploadedUrls: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Validate file type
      if (!file.type.startsWith("image/")) {
        errors.push(`${file.name}: Not an image file`);
        continue;
      }

      // Convert to buffer
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Generate unique filename
      const ext = file.name.split(".").pop() || "png";
      const filename = `lora-training/${Date.now()}-${i}.${ext}`;

      // Upload to Supabase
      const { data, error } = await storageClient.storage
        .from(BUCKET_NAME)
        .upload(filename, buffer, {
          contentType: file.type,
          upsert: true,
        });

      if (error) {
        errors.push(`${file.name}: ${error.message}`);
        continue;
      }

      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/${filename}`;
      uploadedUrls.push(publicUrl);
    }

    return NextResponse.json({
      success: uploadedUrls.length > 0,
      message: `Uploaded ${uploadedUrls.length}/${files.length} images`,
      images: uploadedUrls,
      errors: errors.length > 0 ? errors : undefined,
      next_step: uploadedUrls.length >= 10
        ? `POST /api/admin/lora/train with {"images": [${uploadedUrls.length} URLs]}`
        : `Upload more images - need at least 10, have ${uploadedUrls.length}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * GET /api/admin/lora/upload
 *
 * List already uploaded training images
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedAdminRequest(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const storageClient = supabaseAdmin || freshSupabase();

  const { data: files, error } = await storageClient.storage
    .from(BUCKET_NAME)
    .list("lora-training");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const imageUrls = (files || [])
    .filter(f => !f.name.startsWith("."))
    .map(f => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET_NAME}/lora-training/${f.name}`);

  return NextResponse.json({
    count: imageUrls.length,
    images: imageUrls,
    ready_for_training: imageUrls.length >= 10,
    next_step: imageUrls.length >= 10
      ? "POST /api/admin/lora/train with these image URLs"
      : `Upload more images - need at least 10, have ${imageUrls.length}`,
  });
}
