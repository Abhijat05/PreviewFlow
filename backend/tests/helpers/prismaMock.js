// backend/tests/helpers/prismaMock.js
import { prisma } from "../../src/db.js";

const originalMethods = new Map();
let originalQueryRaw;
let originalExecuteRaw;

/**
 * Creates mock implementations for Prisma models.
 */
export function mockPrisma(overrides = {}) {
  const models = [
    "user",
    "project",
    "preview",
    "previewMetric",
    "build",
    "webhookDelivery",
    "portAllocation",
    "auditLog"
  ];
  const defaultMethods = [
    "findUnique",
    "findFirst",
    "findMany",
    "create",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
    "count"
  ];

  if (originalQueryRaw === undefined) {
    originalQueryRaw = prisma.$queryRaw;
  }
  if (originalExecuteRaw === undefined) {
    originalExecuteRaw = prisma.$executeRaw;
  }

  prisma.$queryRaw = overrides.$queryRaw || (async () => null);
  prisma.$executeRaw = overrides.$executeRaw || (async () => 0);

  for (const model of models) {
    if (!prisma[model]) {
      prisma[model] = {};
    }

    for (const method of defaultMethods) {
      const key = `${model}.${method}`;
      if (!originalMethods.has(key)) {
        originalMethods.set(key, prisma[model][method]);
      }

      if (overrides[model] && overrides[model][method]) {
        prisma[model][method] = overrides[model][method];
      } else if (!overrides[model] || overrides[model][method] === undefined) {
        prisma[model][method] = async () => {
          if (method === "findMany") return [];
          if (method === "count" || method === "updateMany" || method === "deleteMany") return method === "count" ? 0 : { count: 0 };
          return null;
        };
      }
    }
  }

  return {
    restore() {
      for (const [key, original] of originalMethods.entries()) {
        const [model, method] = key.split(".");
        if (original !== undefined) {
          prisma[model][method] = original;
        } else {
          delete prisma[model][method];
        }
      }
      originalMethods.clear();

      if (originalQueryRaw !== undefined) {
        prisma.$queryRaw = originalQueryRaw;
      }
      if (originalExecuteRaw !== undefined) {
        prisma.$executeRaw = originalExecuteRaw;
      }
    }
  };
}

/**
 * Executes an async callback with scoped Prisma mocks and guaranteed restoration.
 */
export async function withMockPrisma(overrides, fn) {
  const { restore } = mockPrisma(overrides);
  try {
    return await fn();
  } finally {
    restore();
  }
}
