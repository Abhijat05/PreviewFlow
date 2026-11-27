// backend/src/routes/internalProxy.js
import express from "express";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

const router = express.Router();

// Matches resolved subdomain pattern from dockerService.resolvePreviewUrl: pr-<num>-b<num>-<shortId>.<domain>
const PREVIEW_HOST_RE = /^pr-(\d+)-b(\d+)-([a-z0-9]+)\.([a-z0-9.-]+)$/i;

function timingSafeMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authorizeInternalProxy(req, expectedToken) {
  if (!expectedToken) return true;
  const header = req.header("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  const altHeader = req.header("X-Internal-Proxy-Token") || null;
  return timingSafeMatch(bearer, expectedToken) || timingSafeMatch(altHeader, expectedToken);
}

/**
 * Internal reverse-proxy upstream lookup endpoint for wildcard preview subdomains.
 * Returns X-Preview-Port & X-Preview-Upstream headers cleanly for Nginx auth_request / dynamic proxy routing.
 */
export async function handleResolvePreviewUpstream(req, res) {
  const configuredToken = process.env.INTERNAL_PROXY_TOKEN;
  if (configuredToken && !authorizeInternalProxy(req, configuredToken)) {
    return res.status(401).json({ error: "unauthorized_internal_proxy" });
  }

  const rawHost = String(req.query?.host || req.header("X-Forwarded-Host") || "")
    .split(",")[0]
    .trim()
    .replace(/:\d+$/, "")
    .toLowerCase();

  if (!rawHost || rawHost.length > 253) {
    return res.status(400).json({ error: "invalid_preview_host" });
  }

  const match = rawHost.match(PREVIEW_HOST_RE);
  if (!match) {
    return res.status(400).json({ error: "invalid_preview_host" });
  }

  const [, prStr, , shortId, domainPart] = match;
  const configuredBaseDomain = (process.env.PREVIEW_BASE_DOMAIN || "")
    .trim()
    .replace(/^\.+/, "")
    .toLowerCase();

  if (configuredBaseDomain && domainPart !== configuredBaseDomain && !domainPart.endsWith(`.${configuredBaseDomain}`)) {
    return res.status(404).json({ error: "unknown_preview_domain" });
  }

  const prNumber = Number.parseInt(prStr, 10);
  const upstreamHost = (process.env.PREVIEW_UPSTREAM_HOST || "127.0.0.1").trim();

  try {
    const candidates = await prisma.preview.findMany({
      where: {
        prNumber,
        status: "live"
      }
    });

    const preview = (candidates || []).find((p) => {
      if (!p.port || !Number.isInteger(p.port)) return false;
      if (p.url && p.url.toLowerCase().includes(rawHost)) return true;
      const cleanIdPrefix = String(p.id || "").slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "");
      return cleanIdPrefix === shortId;
    });

    if (!preview || preview.port < 1024 || preview.port > 65535) {
      return res.status(404).json({ error: "preview_not_live" });
    }

    const upstream = `${upstreamHost}:${preview.port}`;
    res.setHeader("X-Preview-Port", String(preview.port));
    res.setHeader("X-Preview-Upstream", upstream);
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).json({
      ok: true,
      previewId: preview.id,
      prNumber: preview.prNumber,
      port: preview.port,
      upstream
    });
  } catch (err) {
    logger.error("Failed to resolve internal preview upstream", { host: rawHost, err });
    return res.status(500).json({ error: "upstream_resolution_failed" });
  }
}

router.get("/resolve-preview", handleResolvePreviewUpstream);

export default router;
