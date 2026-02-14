// @ts-nocheck
// Redirect alias - /api/v1/fighters/me -> /api/fighter/me
import { GET as actualGet } from "../../../fighter/me/route";

export const dynamic = "force-dynamic";

export const GET = actualGet;
