import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

describe("document asset roots", () => {
  let directory: string;
  let assetRoot: string;
  let projectDir: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-assets-"));
    assetRoot = path.join(directory, "documents");
    projectDir = path.join(assetRoot, "nested");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(assetRoot, "pixel.png"),
      "Shared document image",
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("serves parent-relative document assets inside the configured root", async () => {
    const { app } = createApp({
      projectDir,
      assetRoot,
      homeDir: directory,
      staticDirPath: directory,
    });

    const response = await request(app).get("/api/files").query({
      projectPath: projectDir,
      path: "../pixel.png",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from("Shared document image"));
  });

  it("keeps assets inside the project when no broader root is configured", async () => {
    const { app } = createApp({
      projectDir,
      homeDir: directory,
      staticDirPath: directory,
    });

    const response = await request(app).get("/api/files").query({
      projectPath: projectDir,
      path: "../pixel.png",
    });

    expect(response.status).toBe(404);
  });

  it("does not serve files or symlink destinations outside the document root", async () => {
    const outside = path.join(directory, "outside.png");
    fs.writeFileSync(outside, "Outside document root");
    fs.symlinkSync(outside, path.join(projectDir, "outside-link.png"));
    const { app } = createApp({
      projectDir,
      assetRoot,
      homeDir: directory,
      staticDirPath: directory,
    });

    for (const assetPath of ["../../outside.png", "outside-link.png"]) {
      const response = await request(app).get("/api/files").query({
        projectPath: projectDir,
        path: assetPath,
      });
      expect(response.status).toBe(404);
    }
  });
});
