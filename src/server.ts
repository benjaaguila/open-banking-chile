import express from "express";
import crypto from "crypto";
import { getBank, listBanks } from "./index.js";
import type { ScrapeResult } from "./types.js";

// --- Job Queue (in-memory) ---

type JobStatus = "queued" | "running" | "awaiting_2fa" | "completed" | "failed";

interface Job {
  id: string;
  bank: string;
  status: JobStatus;
  progress?: string;
  result?: ScrapeResult;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

const jobs = new Map<string, Job>();

// Clean up jobs older than 1 hour every 10 minutes
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.completedAt && job.completedAt < oneHourAgo) {
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

// --- Auth middleware ---

const API_KEY = process.env.API_KEY;

function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  if (!API_KEY) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header. Use: Bearer <API_KEY>" });
    return;
  }

  const token = header.slice(7);
  if (token !== API_KEY) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  next();
}

// --- Rate limiting (flexible, configurable) ---

const rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10); // default 1 min
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || "30", 10); // default 30 requests per window
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function rateLimitMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const key = req.headers.authorization || req.ip || "anonymous";
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + rateLimitWindow });
    next();
    return;
  }

  entry.count++;
  if (entry.count > rateLimitMax) {
    res.status(429).json({ error: "Rate limit exceeded. Try again later." });
    return;
  }

  next();
}

// --- Express app ---

const app = express();
app.use(express.json());

// Health check (no auth)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", jobs: jobs.size });
});

// Protected routes
app.use("/api", authMiddleware);
app.use("/api", rateLimitMiddleware);

// List banks
app.get("/api/v1/banks", (_req, res) => {
  res.json(listBanks());
});

// Submit scrape job
app.post("/api/v1/scrape", (req, res) => {
  const { bank, rut, password, owner, fromDate } = req.body;

  if (!bank || !rut || !password) {
    res.status(400).json({ error: "Missing required fields: bank, rut, password" });
    return;
  }

  if (fromDate && !/^\d{2}-\d{2}-\d{4}$/.test(fromDate)) {
    res.status(400).json({ error: "fromDate debe estar en formato DD-MM-YYYY (ej: 01-03-2026)" });
    return;
  }

  const scraper = getBank(bank);
  if (!scraper) {
    res.status(404).json({
      error: `Bank "${bank}" not found`,
      available: listBanks().map((b) => b.id),
    });
    return;
  }

  const jobId = crypto.randomUUID();
  const job: Job = {
    id: jobId,
    bank,
    status: "queued",
    createdAt: Date.now(),
  };
  jobs.set(jobId, job);

  // Run scrape in background (fire and forget)
  runScrapeJob(job, scraper, { rut, password, owner, fromDate });

  res.status(202).json({ jobId, status: "queued" });
});

// Get job status
app.get("/api/v1/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const response: Record<string, unknown> = {
    id: job.id,
    bank: job.bank,
    status: job.status,
    createdAt: job.createdAt,
  };

  if (job.progress) response.progress = job.progress;
  if (job.completedAt) response.completedAt = job.completedAt;

  if (job.status === "completed" && job.result) {
    const { screenshot: _, debug: __, ...safeResult } = job.result;
    response.result = safeResult;
  }

  if (job.status === "failed") {
    response.error = job.error;
  }

  res.json(response);
});

// Cancel / delete job
app.delete("/api/v1/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  jobs.delete(req.params.id);
  res.json({ deleted: true });
});

// --- Scrape execution ---

async function runScrapeJob(
  job: Job,
  scraper: ReturnType<typeof getBank> & {},
  credentials: { rut: string; password: string; owner?: string; fromDate?: string },
) {
  job.status = "running";
  job.progress = "Iniciando scraping...";

  let rut: string | null = credentials.rut;
  let password: string | null = credentials.password;

  try {
    const result = await scraper.scrape({
      rut: rut!,
      password: password!,
      chromePath: process.env.CHROME_PATH,
      saveScreenshots: false,
      headful: false,
      owner: credentials.owner as "T" | "A" | "B" | undefined,
      fromDate: credentials.fromDate,
      onProgress: (step: string) => {
        job.progress = step;
        // Detect 2FA from progress messages
        const lower = step.toLowerCase();
        if (
          lower.includes("2fa") ||
          lower.includes("segundo factor") ||
          lower.includes("clave dinámica") ||
          lower.includes("superclave")
        ) {
          job.status = "awaiting_2fa";
        }
      },
    });

    job.status = result.success ? "completed" : "failed";
    job.result = result;
    job.error = result.error;
    job.completedAt = Date.now();
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : "Unknown error";
    job.completedAt = Date.now();
  } finally {
    // Discard credentials from memory
    rut = null;
    password = null;
  }
}

// --- Start server ---

const PORT = parseInt(process.env.PORT || "8080", 10);

app.listen(PORT, () => {
  console.log(`open-banking-chile API listening on port ${PORT}`);
  if (!API_KEY) {
    console.warn("WARNING: No API_KEY set. API is unprotected.");
  }
});
