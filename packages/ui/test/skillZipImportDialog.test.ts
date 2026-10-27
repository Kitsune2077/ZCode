// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE } from "@zcode/shared";
import type { ISkillSyncService } from "@zcode/services";
import {
  SkillZipImportDialog,
  isZipFilePath,
} from "../src/settings/SkillZipImportDialog.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const selectFileMock = vi.fn(async () => null);

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

const dialogPropsCapture: Array<Record<string, unknown>> = [];

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: (props: Record<string, unknown>) => {
    dialogPropsCapture.push(props);
    return props.open ? createElement("div", { "data-dialog-open": "true" }, props.children) : null;
  },
  DialogContent: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  DialogHeader: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  DialogTitle: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("h2", props, children),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    selectFile: selectFileMock,
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) => {
        const messages: Record<string, string> = {
          "settings.skills.zipImport.title": "Import skills from a ZIP file",
          "settings.skills.zipImport.description":
            "Each directory containing a SKILL.md is imported into ~/.zcode/skills.",
          "settings.skills.zipImport.select": "Choose ZIP file",
          "settings.skills.zipImport.importing": "Importing skills...",
          "settings.skills.zipImport.notZipFile": "Please choose a .zip archive.",
          "settings.skills.zipImport.complete": "Skill import complete.",
          "settings.skills.zipImport.emptyArchive": "No skill directories were found.",
          "settings.skills.zipImport.synced": "Imported",
          "settings.skills.zipImport.skipped": "Skipped",
          "settings.skills.zipImport.failed": "Failed",
          "settings.skills.remoteSync.sizeLimit.archive":
            "Sync failed: the archive is about {actualSize}, exceeding the {maxSize} limit.",
          "common.close": "Close",
        };
        let message = messages[id] ?? id;
        for (const [key, value] of Object.entries(values ?? {})) {
          message = message.replaceAll(`{${key}}`, String(value));
        }
        return message;
      },
    },
  }),
}));

afterEach(() => {
  cleanup();
  dialogPropsCapture.length = 0;
  selectFileMock.mockReset();
  selectFileMock.mockResolvedValue(null);
});

function createSkillSyncServiceStub(): ISkillSyncService {
  return {
    listLocalUserSkillCandidates: vi.fn(async () => ({
      maxArchiveBytes: 1024 * 1024,
      candidates: [],
    })),
    listRemoteUserSkillStatuses: vi.fn(async () => ({ statuses: [] })),
    exportSkillsArchive: vi.fn(async () => ({
      archive: new Uint8Array(),
      archiveBytes: 0,
      skills: [],
    })),
    checkRemoteUserSkillWriteAccess: vi.fn(async () => ({
      ok: true,
      path: "/home/dev/.zcode/skills",
    })),
    importSkillsArchive: vi.fn(async () => ({ results: [] })),
    importSkillsZipArchive: vi.fn(async () => ({ results: [] })),
  };
}

function renderDialog(overrides: {
  skillSyncService?: ISkillSyncService;
  onImported?: () => Promise<void> | void;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const skillSyncService = overrides.skillSyncService ?? createSkillSyncServiceStub();
  const onImported = overrides.onImported ?? vi.fn(async () => undefined);
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const view = render(
    createElement(SkillZipImportDialog, {
      open: true,
      onOpenChange,
      skillSyncService,
      onImported,
    }),
  );
  return { view, skillSyncService, onImported, onOpenChange };
}

describe("isZipFilePath", () => {
  it("accepts case-insensitive .zip paths", () => {
    expect(isZipFilePath("/tmp/skills.zip")).toBe(true);
    expect(isZipFilePath("/tmp/SKILLS.ZIP")).toBe(true);
    expect(isZipFilePath("  /tmp/skills.zip  ")).toBe(true);
  });

  it("rejects other extensions and empty paths", () => {
    expect(isZipFilePath("/tmp/skills.tar.gz")).toBe(false);
    expect(isZipFilePath("/tmp/skills.zip.bak")).toBe(false);
    expect(isZipFilePath("")).toBe(false);
  });
});

describe("SkillZipImportDialog", () => {
  it("keeps zip i18n copy available in both locales", () => {
    const messageIds = [
      "settings.skills.zipImport.open",
      "settings.skills.zipImport.title",
      "settings.skills.zipImport.description",
      "settings.skills.zipImport.select",
      "settings.skills.zipImport.importing",
      "settings.skills.zipImport.notZipFile",
      "settings.skills.zipImport.complete",
      "settings.skills.zipImport.emptyArchive",
      "settings.skills.zipImport.synced",
      "settings.skills.zipImport.skipped",
      "settings.skills.zipImport.failed",
    ];
    for (const messageId of messageIds) {
      expect(enUS[messageId]).toBeTruthy();
      expect(zhCN[messageId]).toBeTruthy();
    }
  });

  it("treats cancelling the file picker as a no-op", async () => {
    selectFileMock.mockResolvedValue(null);
    const { skillSyncService } = renderDialog();

    fireEvent.click(screen.getByText("Choose ZIP file"));
    await waitFor(() => {
      expect(selectFileMock).toHaveBeenCalledTimes(1);
    });

    expect(skillSyncService.importSkillsZipArchive).not.toHaveBeenCalled();
    expect(screen.getByText("Choose ZIP file")).toBeTruthy();
  });

  it("rejects non-zip selections without calling the service", async () => {
    selectFileMock.mockResolvedValue("/tmp/skills.tar.gz");
    const { skillSyncService } = renderDialog();

    fireEvent.click(screen.getByText("Choose ZIP file"));
    await waitFor(() => {
      expect(screen.getByText("Please choose a .zip archive.")).toBeTruthy();
    });

    expect(skillSyncService.importSkillsZipArchive).not.toHaveBeenCalled();
  });

  it("imports the selected zip and renders per-skill results", async () => {
    selectFileMock.mockResolvedValue("/tmp/skills.zip");
    const skillSyncService = createSkillSyncServiceStub();
    skillSyncService.importSkillsZipArchive = vi.fn(async () => ({
      results: [
        { name: "review", directoryName: "review", status: "synced" as const },
        {
          name: "docs",
          directoryName: "docs",
          status: "skipped" as const,
          path: "/home/dev/.zcode/skills/docs",
        },
      ],
    }));
    const onImported = vi.fn(async () => undefined);
    renderDialog({ skillSyncService, onImported });

    fireEvent.click(screen.getByText("Choose ZIP file"));
    await waitFor(() => {
      expect(screen.getByText("Skill import complete.")).toBeTruthy();
    });

    expect(skillSyncService.importSkillsZipArchive).toHaveBeenCalledWith({
      filePath: "/tmp/skills.zip",
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
  });

  it("hints an empty archive when no skill directories were found", async () => {
    selectFileMock.mockResolvedValue("/tmp/empty.zip");
    const skillSyncService = createSkillSyncServiceStub();
    skillSyncService.importSkillsZipArchive = vi.fn(async () => ({ results: [] }));
    renderDialog({ skillSyncService });

    fireEvent.click(screen.getByText("Choose ZIP file"));
    await waitFor(() => {
      expect(screen.getByText("No skill directories were found.")).toBeTruthy();
    });
  });

  it("blocks closing while an import is in flight", async () => {
    let resolveImport: (result: { results: never[] }) => void = () => undefined;
    selectFileMock.mockResolvedValue("/tmp/skills.zip");
    const skillSyncService = createSkillSyncServiceStub();
    skillSyncService.importSkillsZipArchive = vi.fn(
      () =>
        new Promise<{ results: never[] }>((resolve) => {
          resolveImport = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    renderDialog({ skillSyncService, onOpenChange });

    fireEvent.click(screen.getByText("Choose ZIP file"));
    await waitFor(() => {
      expect(screen.getByText("Importing skills...")).toBeTruthy();
    });

    const dialog = dialogPropsCapture.at(-1);
    (dialog?.onOpenChange as (open: boolean) => void)?.(false);
    expect(onOpenChange).not.toHaveBeenCalled();

    resolveImport({ results: [] });
    await waitFor(() => {
      expect(screen.getByText("Skill import complete.")).toBeTruthy();
    });
  });

  it("returns to the pick step and shows the error when the import fails", async () => {
    selectFileMock.mockResolvedValue("/tmp/skills.zip");
    const skillSyncService = createSkillSyncServiceStub();
    skillSyncService.importSkillsZipArchive = vi.fn(async () => {
      throw new Error("boom");
    });
    renderDialog({ skillSyncService });

    fireEvent.click(screen.getByText("Choose ZIP file"));
    await waitFor(() => {
      expect(screen.getByText("boom")).toBeTruthy();
    });
    expect(screen.getByText("Choose ZIP file")).toBeTruthy();
  });

  it("localizes structured size limit errors", async () => {
    selectFileMock.mockResolvedValue("/tmp/huge.zip");
    const skillSyncService = createSkillSyncServiceStub();
    skillSyncService.importSkillsZipArchive = vi.fn(async () => {
      throw Object.assign(new Error("skill sync size limit exceeded"), {
        code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
        data: {
          actualBytes: 56_220_152,
          maxBytes: 20 * 1024 * 1024,
          phase: "archive",
        },
      });
    });
    renderDialog({ skillSyncService });

    fireEvent.click(screen.getByText("Choose ZIP file"));
    await waitFor(() => {
      expect(
        screen.getByText(
          "Sync failed: the archive is about 53.6 MiB, exceeding the 20 MiB limit.",
        ),
      ).toBeTruthy();
    });
  });
});
