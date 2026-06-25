import app from "../apps/api/src/server.js";

export default function (req: any, res: any) {
  if (req.url?.startsWith("/api")) {
    req.url = req.url.replace(/^\/api/, "");
  }
  return app(req, res);
}
