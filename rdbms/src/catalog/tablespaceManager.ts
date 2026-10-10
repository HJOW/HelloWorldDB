/**
 * 테이블스페이스 관리.
 *
 * 담당
 *  - 테이블스페이스 목록 : 이름, 데이터 파일 경로, 포맷 버전, 캐릭터셋, 상태. SYSTEM 테이블스페이스에 저장한다.
 *  - CREATE TABLESPACE : 데이터 파일 생성. 경로를 생략하면 `<dataDir>/<이름>.hwdb`
 *  - DROP TABLESPACE : 객체가 남아 있으면 INCLUDING CONTENTS 필요. 데이터 파일과 관련 권한 기록 삭제.
 *    SYSTEM 은 삭제할 수 없다.
 *  - 구동할 때 테이블스페이스 열기. 데이터 파일이 없거나 손상되었거나, 모르는 포맷 버전이나
 *    캐릭터셋이면 그 테이블스페이스만 사용 불가로 두고 나머지는 정상 구동한다.
 *    SYSTEM 이 그런 경우에는 구동에 실패한다.
 *
 * 관련 사양 : AGENTS.md 상세 2, 3
 * 구현 단계 : 5단계
 */

import fs from "node:fs";
import path from "node:path";
import { DbError, ERROR_CODES, unsupportedFeature } from "../common/errors.js";
import type { SourcePosition } from "../common/errors.js";
import { RDBMS_VERSION } from "../common/instance.js";
import {
  createTablespace as createTablespaceFile,
  openTablespace as openTablespaceFile,
  LATEST_FORMAT_VERSION,
} from "../storage/format/format.js";
import type { Tablespace } from "../storage/format/format.js";
import {
  CatalogStore,
  emptyCatalog,
  emptySystemCatalog,
  parseCatalog,
  serializeCatalog,
} from "./catalog.js";
import type { CatalogData, TablespaceRecord } from "./catalog.js";

function catalogError(sqlState: string, code: number, message: string, position?: SourcePosition): DbError {
  const error = new DbError(sqlState, code, message);
  if (position !== undefined) {
    const { withPosition } = { withPosition: undefined as unknown as (e: DbError, p: SourcePosition) => DbError };
    void withPosition;
    // 순환 import 를 피하려고 withPosition 을 직접 쓰지 않고 위치를 붙인다.
    return new DbError(sqlState, code, `${message.replace(/\.$/, "")} (line ${position.line}, column ${position.column}).`, {
      position,
    });
  }
  return error;
}

export interface TablespaceStatus {
  name: string;
  dataFile: string;
  characterSet: string;
  formatVersion: number;
  available: boolean;
  reason: string | null;
}

export interface TablespaceManagerOptions {
  serverVersion?: string;
  onWarning?: (message: string) => void;
}

/**
 * 데이터 디렉토리 안의 테이블스페이스 파일들을 들고 있는다.
 * SYSTEM 카탈로그의 system.tablespaces 가 목록의 기준이다.
 */
export class TablespaceManager {
  private constructor(
    readonly dataDir: string,
    readonly serverVersion: string,
    private readonly onWarning: ((message: string) => void) | undefined,
  ) {}

  private spaces = new Map<string, Tablespace>();
  private catalogs = new Map<string, CatalogStore>();
  private unavailable = new Map<string, string>();
  private registry = new Map<string, TablespaceRecord>();

  /** 데이터 디렉토리를 열고 모든 테이블스페이스를 연다. SYSTEM 이 없으면 새로 만든다. */
  static open(dataDir: string, options: TablespaceManagerOptions = {}): TablespaceManager {
    const resolvedDir = path.resolve(dataDir);
    fs.mkdirSync(resolvedDir, { recursive: true });
    const manager = new TablespaceManager(resolvedDir, options.serverVersion ?? RDBMS_VERSION, options.onWarning);
    manager.bootstrapSystem();
    manager.openListed();
    return manager;
  }

  /** SYSTEM 파일이 없으면 새로 만든다. 있으면 열어 레지스트리를 읽는다. */
  private bootstrapSystem(): void {
    const systemFile = path.join(this.dataDir, "SYSTEM.hwdb");
    let space: Tablespace | null = null;
    try {
      space = openTablespaceFile(systemFile, { onWarning: this.onWarning });
    } catch (error) {
      if (!isMissingFile(error) || fs.existsSync(systemFile)) {
        throw error;
      }
    }
    if (space === null) {
      const created = createTablespaceFile(systemFile, {
        name: "SYSTEM",
        serverVersion: this.serverVersion,
        characterSet: "UTF8",
      });
      try {
        const data: CatalogData = emptySystemCatalog();
        data.system = {
          tablespaces: {
            SYSTEM: {
              name: "SYSTEM",
              dataFile: systemFile,
              characterSet: "UTF8",
              formatVersion: LATEST_FORMAT_VERSION,
            },
          },
        };
        const batch = created.begin();
        try {
          batch.setCatalog(serializeCatalog(data));
          batch.commit();
        } catch (batchError) {
          try {
            batch.rollback();
          } catch {
            // 원래 오류를 유지한다.
          }
          throw batchError;
        }
        this.spaces.set("SYSTEM", created);
        this.catalogs.set("SYSTEM", new CatalogStore("SYSTEM", created, data));
        this.registry.set("SYSTEM", {
          name: "SYSTEM",
          dataFile: systemFile,
          characterSet: "UTF8",
          formatVersion: LATEST_FORMAT_VERSION,
        });
        return;
      } catch (error) {
        try {
          created.close();
        } catch {
          // 생성 실패 뒤의 닫기 오류는 원래 오류를 가리지 않는다.
        }
        try {
          fs.rmSync(systemFile, { force: true });
        } catch {
          // 파일 삭제 실패도 원래 오류를 가리지 않는다.
        }
        throw error;
      }
    }
    try {
      const data = parseCatalog(space.getCatalog(), "SYSTEM");
      if (data.system === undefined) {
        data.system = { tablespaces: {} };
      }
      if (data.system.tablespaces["SYSTEM"] === undefined) {
        data.system.tablespaces["SYSTEM"] = {
          name: "SYSTEM",
          dataFile: systemFile,
          characterSet: "UTF8",
          formatVersion: space.header.formatVersion,
        };
      }
      this.spaces.set("SYSTEM", space);
      this.catalogs.set("SYSTEM", new CatalogStore("SYSTEM", space, data));
      for (const [name, record] of Object.entries(data.system.tablespaces)) {
        this.registry.set(name, record);
      }
      // SYSTEM 레지스트리에 적힌 SYSTEM 경로가 실제와 다르면 실제 경로로 고친다.
      const systemRecord = this.registry.get("SYSTEM");
      if (systemRecord !== undefined && path.resolve(systemRecord.dataFile) !== path.resolve(systemFile)) {
        systemRecord.dataFile = systemFile;
        this.saveRegistry();
      }
    } catch (error) {
      try {
        space.close();
      } catch {
        // 닫기 오류는 원래 오류를 가리지 않는다.
      }
      throw error;
    }
  }

  /** SYSTEM 레지스트리에 적힌 테이블스페이스를 하나씩 연다. */
  private openListed(): void {
    const systemCatalog = this.catalogs.get("SYSTEM");
    if (systemCatalog === undefined) {
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "SYSTEM tablespace is not open.");
    }
    for (const [name, record] of this.registry) {
      if (name === "SYSTEM") continue;
      const filePath = path.resolve(record.dataFile);
      try {
        const space = openTablespaceFile(filePath, { onWarning: this.onWarning });
        if (space.header.characterSet !== "UTF8") {
          throw unsupportedFeature(`Unsupported character set in tablespace "${name}".`);
        }
        const data = parseCatalog(space.getCatalog(), name);
        this.spaces.set(name, space);
        this.catalogs.set(name, new CatalogStore(name, space, data));
      } catch (error) {
        const reason = error instanceof DbError ? error.message : String(error);
        this.unavailable.set(name, reason);
        this.onWarning?.(`Tablespace "${name}" is unavailable: ${reason}`);
      }
    }
  }

  /** 관리 중인 테이블스페이스 이름들을 돌려준다. 레지스트리 기준이다. */
  listNames(): string[] {
    return [...this.registry.keys()];
  }

  /** 딕셔너리 뷰용으로 상태 목록을 돌려준다. */
  listStatus(): TablespaceStatus[] {
    const result: TablespaceStatus[] = [];
    for (const [name, record] of this.registry) {
      const space = this.spaces.get(name);
      const reason = this.unavailable.get(name) ?? null;
      result.push({
        name,
        dataFile: record.dataFile,
        characterSet: record.characterSet,
        formatVersion: space?.header.formatVersion ?? record.formatVersion,
        available: space !== undefined && reason === null,
        reason,
      });
    }
    result.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return result;
  }

  /** 테이블스페이스가 있는지 본다. 사용 불가 상태도 있는 것으로 본다. */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** 사용 가능한 테이블스페이스의 카탈로그를 돌려준다. 없거나 사용 불가면 오류이다. */
  requireCatalog(name: string, position?: SourcePosition): CatalogStore {
    if (!this.registry.has(name)) {
      throw catalogError("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${name}".`, position);
    }
    const reason = this.unavailable.get(name);
    if (reason !== undefined) {
      throw new DbError("58030", ERROR_CODES.STORAGE_IO, `Tablespace is unavailable: "${name}".`);
    }
    const catalog = this.catalogs.get(name);
    if (catalog === undefined) {
      throw new DbError("58030", ERROR_CODES.STORAGE_IO, `Tablespace is unavailable: "${name}".`);
    }
    return catalog;
  }

  /** SYSTEM 카탈로그를 돌려준다. */
  systemCatalog(): CatalogStore {
    const catalog = this.catalogs.get("SYSTEM");
    if (catalog === undefined) {
      throw new DbError("XX000", ERROR_CODES.INTERNAL_ERROR, "SYSTEM tablespace is not open.");
    }
    return catalog;
  }

  /** SYSTEM 레지스트리를 파일에 쓴다. */
  saveRegistry(): void {
    const system = this.systemCatalog();
    const registry: Record<string, TablespaceRecord> = {};
    for (const [name, record] of this.registry) {
      registry[name] = record;
    }
    if (system.data.system === undefined) {
      system.data.system = { tablespaces: {} };
    }
    system.data.system.tablespaces = registry;
    system.save();
  }

  /** CREATE TABLESPACE 를 실행한다. */
  createTablespace(
    name: string,
    dataFile: string | null,
    characterSet: string | null,
    position?: SourcePosition,
  ): void {
    if (this.registry.has(name)) {
      throw catalogError("42P06", ERROR_CODES.TABLESPACE_EXISTS, `Tablespace already exists: "${name}".`, position);
    }
    const charset = (characterSet ?? "UTF8").toUpperCase();
    if (charset !== "UTF8") {
      throw unsupportedFeature(`Only UTF8 is supported (tablespace "${name}").`);
    }
    const filePath = dataFile === null ? path.join(this.dataDir, `${name}.hwdb`) : resolveDataFile(this.dataDir, dataFile);
    for (const record of this.registry.values()) {
      if (path.resolve(record.dataFile) === path.resolve(filePath)) {
        throw catalogError(
          "42P06",
          ERROR_CODES.TABLESPACE_EXISTS,
          `Data file is already used by another tablespace: "${filePath}".`,
          position,
        );
      }
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const space = createTablespaceFile(filePath, { name, serverVersion: this.serverVersion, characterSet: "UTF8" });
    try {
      const data: CatalogData = emptyCatalog();
      const batch = space.begin();
      try {
        batch.setCatalog(serializeCatalog(data));
        batch.commit();
      } catch (batchError) {
        try {
          batch.rollback();
        } catch {
          // 원래 오류를 유지한다.
        }
        throw batchError;
      }
      this.spaces.set(name, space);
      this.catalogs.set(name, new CatalogStore(name, space, data));
      this.registry.set(name, { name, dataFile: filePath, characterSet: "UTF8", formatVersion: LATEST_FORMAT_VERSION });
      try {
        this.saveRegistry();
      } catch (registryError) {
        this.spaces.delete(name);
        this.catalogs.delete(name);
        this.registry.delete(name);
        throw registryError;
      }
    } catch (error) {
      try {
        space.close();
      } catch {
        // 닫기 오류는 원래 오류를 가리지 않는다.
      }
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // 파일 삭제 실패도 원래 오류를 가리지 않는다.
      }
      throw error;
    }
  }

  /** DROP TABLESPACE 를 실행한다. */
  dropTablespace(name: string, includingContents: boolean, position?: SourcePosition): void {
    if (name === "SYSTEM") {
      throw catalogError("55006", ERROR_CODES.OBJECT_IN_USE, 'Tablespace "SYSTEM" cannot be dropped.', position);
    }
    const record = this.registry.get(name);
    if (record === undefined) {
      throw catalogError("3D000", ERROR_CODES.TABLESPACE_NOT_FOUND, `Tablespace does not exist: "${name}".`, position);
    }
    const catalog = this.catalogs.get(name);
    const hasObjects =
      catalog === undefined
        ? true
        : Object.keys(catalog.data.tables).length > 0 ||
          Object.keys(catalog.data.views).length > 0 ||
          Object.keys(catalog.data.indexes).length > 0 ||
          Object.keys(catalog.data.constraints).length > 0;
    if (hasObjects && !includingContents) {
      throw catalogError(
        "55006",
        ERROR_CODES.OBJECT_IN_USE,
        `Tablespace "${name}" is not empty; use INCLUDING CONTENTS to drop it.`,
        position,
      );
    }
    const space = this.spaces.get(name);
    const filePath = path.resolve(record.dataFile);
    if (space !== undefined) {
      try {
        space.close();
      } catch {
        // 닫기 오류는 삭제를 막지 않는다.
      }
    }
    this.spaces.delete(name);
    this.catalogs.delete(name);
    this.unavailable.delete(name);
    this.registry.delete(name);
    try {
      this.saveRegistry();
    } catch (error) {
      // 레지스트리 저장 실패는 삭제를 되돌리지 않고 알린다.
      throw error;
    }
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // 파일 삭제 실패는 레지스트리에서 지운 뒤에는 경고로 남긴다.
      this.onWarning?.(`Cannot delete data file of tablespace "${name}": "${filePath}".`);
    }
  }

  /** 모든 테이블스페이스를 닫는다. */
  close(): void {
    for (const space of this.spaces.values()) {
      try {
        space.close();
      } catch {
        // 닫기 중 하나의 실패가 나머지를 막지 않는다.
      }
    }
    this.spaces.clear();
    this.catalogs.clear();
  }
}

/** DATAFILE 경로를 푼다. 상대 경로는 데이터 디렉토리 기준이다. */
function resolveDataFile(dataDir: string, dataFile: string): string {
  if (dataFile.length === 0) {
    throw new DbError("22023", ERROR_CODES.STORAGE_ARGUMENT, "Data file path must not be empty.");
  }
  return path.isAbsolute(dataFile) ? path.normalize(dataFile) : path.resolve(dataDir, dataFile);
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof DbError &&
    error.sqlState === "58030" &&
    typeof error.message === "string" &&
    /Cannot open data file|ENOENT/i.test(error.message)
  );
}
