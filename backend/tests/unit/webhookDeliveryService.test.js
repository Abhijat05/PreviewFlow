// backend/tests/unit/webhookDeliveryService.test.js
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/db.js";
import { mockPrisma } from "../helpers/prismaMock.js";
import {
  recordDelivery,
  isDuplicateDelivery,
  markDeliveryProcessed,
  getDeliveryById
} from "../../src/services/webhookDeliveryService.js";

describe("webhookDeliveryService Unit Tests", () => {
  let prismaRestore;

  beforeEach(() => {
    const { restore } = mockPrisma();
    prismaRestore = restore;
  });

  afterEach(() => {
    if (prismaRestore) prismaRestore();
  });

  test("recordDelivery validates required arguments", async () => {
    await assert.rejects(
      async () => recordDelivery({}),
      /deliveryId is required/
    );
    await assert.rejects(
      async () => recordDelivery({ deliveryId: "del-123" }),
      /eventType is required/
    );
  });

  test("recordDelivery stores delivery record with RECEIVED status", async () => {
    let createdData = null;
    prisma.webhookDelivery.create = async ({ data }) => {
      createdData = { id: "rec-1", ...data };
      return createdData;
    };

    const delivery = await recordDelivery({
      deliveryId: "del-uuid-456",
      eventType: "pull_request",
      action: "opened",
      projectId: "proj-1",
      prNumber: 42,
      commitSha: "sha-abc-123"
    });

    assert.equal(delivery.deliveryId, "del-uuid-456");
    assert.equal(delivery.status, "RECEIVED");
    assert.equal(delivery.prNumber, 42);
    assert.equal(delivery.commitSha, "sha-abc-123");
    assert.equal(createdData.projectId, "proj-1");
  });

  test("isDuplicateDelivery returns true for existing delivery and false for new", async () => {
    prisma.webhookDelivery.findUnique = async ({ where }) => {
      if (where.deliveryId === "existing-uuid") {
        return { id: "rec-existing", deliveryId: "existing-uuid", status: "PROCESSED" };
      }
      return null;
    };

    assert.equal(await isDuplicateDelivery("existing-uuid"), true);
    assert.equal(await isDuplicateDelivery("new-uuid"), false);
    assert.equal(await isDuplicateDelivery(null), false);
  });

  test("markDeliveryProcessed updates status and processedAt timestamp", async () => {
    let updatedData = null;
    prisma.webhookDelivery.update = async ({ where, data }) => {
      updatedData = { deliveryId: where.deliveryId, ...data };
      return updatedData;
    };

    const res = await markDeliveryProcessed("del-uuid-456", { status: "PROCESSED" });
    assert.equal(res.deliveryId, "del-uuid-456");
    assert.equal(res.status, "PROCESSED");
    assert.ok(res.processedAt);
    assert.equal(res.errorMessage, null);
  });

  test("markDeliveryProcessed handles errors and records errorMessage", async () => {
    let updatedData = null;
    prisma.webhookDelivery.update = async ({ where, data }) => {
      updatedData = { deliveryId: where.deliveryId, ...data };
      return updatedData;
    };

    const res = await markDeliveryProcessed("del-uuid-789", {
      status: "FAILED",
      errorMessage: "Quota exceeded"
    });
    assert.equal(res.status, "FAILED");
    assert.equal(res.errorMessage, "Quota exceeded");
  });

  test("getDeliveryById fetches delivery record", async () => {
    const mockRecord = { id: "rec-1", deliveryId: "del-101", eventType: "pull_request" };
    prisma.webhookDelivery.findUnique = async ({ where }) => {
      if (where.deliveryId === "del-101") return mockRecord;
      return null;
    };

    const found = await getDeliveryById("del-101");
    assert.deepEqual(found, mockRecord);
    const notFound = await getDeliveryById("unknown");
    assert.equal(notFound, null);
  });
});
