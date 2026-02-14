// @ts-nocheck
// Redirect alias - people might try /api/v1/fighters/register
// Actual endpoint is /api/fighter/register

import { POST as actualPost, GET as actualGet } from "../../../fighter/register/route";

export const dynamic = "force-dynamic";

export const POST = actualPost;
export const GET = actualGet;
