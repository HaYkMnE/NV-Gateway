// Base URL of the deployed Cloudflare Worker that receives feedback and
// error reports (POST /v1/feedback, POST /v1/error).  Not a secret — the
// worker accepts unauthenticated writes and answers { ok: true, id }.
export const REPORTS_BASE_URL = "https://nv-gateway-reports.nvgw-sys.workers.dev";
