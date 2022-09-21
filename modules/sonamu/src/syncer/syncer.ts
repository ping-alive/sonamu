import path, { dirname } from "path";
import { globAsync, importMultiple } from "../utils/utils";
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  readJSON,
  writeFile,
  writeFileSync,
  writeJSON,
} from "fs-extra";
import crypto from "crypto";
import equal from "fast-deep-equal";
import { differenceWith, groupBy, isEqual, uniq } from "lodash";
import { camelize } from "inflection";
import { SMDManager } from "../smd/smd-manager";
import * as ts from "typescript";
import {
  ApiParam,
  ApiParamType,
  isBelongsToOneRelationProp,
  isBigIntegerProp,
  isBooleanProp,
  isDateProp,
  isDateTimeProp,
  isDecimalProp,
  isDoubleProp,
  isEnumProp,
  isFloatProp,
  isIntegerProp,
  isJsonProp,
  isOneToOneRelationProp,
  isRelationProp,
  isStringProp,
  isTextProp,
  isTimeProp,
  isTimestampProp,
  isUuidProp,
  isVirtualProp,
  SMDProp,
  SMDPropNode,
  SQLDateTimeString,
} from "../types/types";
import {
  ApiDecoratorOptions,
  registeredApis,
  ExtendedApi,
} from "../api/decorators";
import { z } from "zod";
import chalk from "chalk";
import {
  TemplateKey,
  PathAndCode,
  TemplateOptions,
  GenerateOptions,
  RenderingNode,
} from "../types/types";
import {
  AlreadyProcessedException,
  BadRequestException,
  ServiceUnavailableException,
} from "../exceptions/so-exceptions";
import { wrapIf } from "../utils/lodash-able";
import { getTextTypeLength } from "../api/code-converters";
import { Template } from "../templates/base-template";
import { Template__generated } from "../templates/generated.template";
import { Template__init_enums } from "../templates/init_enums.template";
import { Template__init_generated } from "../templates/init_generated.template";
import { Template__init_types } from "../templates/init_types.template";
import { Template__smd } from "../templates/smd.template";
import { Template__model } from "../templates/model.template";
import { Template__model_test } from "../templates/model_test.template";
import { Template__service } from "../templates/service.template";
import { Template__view_form } from "../templates/view_form.template";
import { Template__view_list } from "../templates/view_list.template";
import prettier from "prettier";
import { Template__view_id_all_select } from "../templates/view_id_all_select.template";
import { Template__view_id_async_select } from "../templates/view_id_async_select.template";
import { Template__view_enums_dropdown } from "../templates/view_enums_dropdown.template";
import { Template__view_enums_select } from "../templates/view_enums_select.template";
import { Template__view_enums_buttonset } from "../templates/view_enums_buttonset.template";
import { Template__view_search_input } from "../templates/view_search_input.template";
import { Template__view_list_columns } from "../templates/view_list_columns.template";
import { Template__generated_http } from "../templates/generated_http.template";

type SyncerConfig = {
  appRootPath: string;
  checksumsPath: string;
  targets: string[];
};
type FileType = "model" | "types" | "enums" | "smd" | "generated";
type GlobPattern = {
  [key in FileType]: string;
};
type PathAndChecksum = {
  path: string;
  checksum: string;
};
type DiffGroups = {
  [key in FileType]: string[];
};
export type RenderedTemplate = {
  target: string;
  path: string;
  body: string;
  importKeys: string[];
  customHeaders?: string[];
  preTemplates?: {
    key: TemplateKey;
    options: TemplateOptions[TemplateKey];
  }[];
};

export class Syncer {
  private static instance: Syncer;
  public static getInstance(config?: Partial<SyncerConfig>) {
    if (this.instance && config !== undefined) {
      throw new Error("Syncer has already configured.");
    }
    return this.instance ?? (this.instance = new this(config));
  }

  config: SyncerConfig;
  apis: {
    typeParameters: ApiParamType.TypeParam[];
    parameters: ApiParam[];
    returnType: ApiParamType;
    modelName: string;
    methodName: string;
    path: string;
    options: ApiDecoratorOptions;
  }[] = [];
  types: { [typeName: string]: z.ZodObject<any> } = {};

  private constructor(config?: Partial<SyncerConfig>) {
    const appRootPath =
      config?.appRootPath ?? path.resolve(__dirname, "../../");
    this.config = {
      appRootPath,
      checksumsPath: `${appRootPath}/api/.tf-checksum`,
      targets: ["web"],
      ...config,
    };
  }

  async sync(): Promise<void> {
    // 트리거와 무관하게 shared 분배
    await Promise.all(
      this.config.targets.map(async (target) => {
        const srcCodePath = path
          .join(__dirname, `../shared/${target}.shared.ts.txt`)
          .replace("/dist/", "/src/");
        if (!existsSync(srcCodePath)) {
          return;
        }

        const dstCodePath = path.join(
          this.config.appRootPath,
          target,
          "src/services/sonamu.shared.ts"
        );

        const srcChecksum = await this.getChecksumOfFile(srcCodePath);
        const dstChecksum = await (async () => {
          if (existsSync(dstCodePath) === false) {
            return "";
          }
          return this.getChecksumOfFile(dstCodePath);
        })();

        if (srcChecksum === dstChecksum) {
          return;
        }
        writeFileSync(dstCodePath, readFileSync(srcCodePath));
      })
    );

    // 현재 checksums
    const currentChecksums = await this.getCurrentChecksums();
    // 이전 checksums
    const previousChecksums = await this.getPreviousChecksums();

    // 비교
    const isSame = equal(currentChecksums, previousChecksums);
    if (isSame) {
      const msg = "Every files are synced!";
      const margin = (process.stdout.columns - msg.length) / 2;
      console.log(
        chalk.black.bgGreen(" ".repeat(margin) + msg + " ".repeat(margin))
      );
      return;
    }

    // 변경된 파일 찾기
    const diff = differenceWith(currentChecksums, previousChecksums, isEqual);
    const diffFiles = diff.map((r) => r.path);
    console.log("Changed Files: ", diffFiles);

    // 다른 부분 찾아 액션
    const diffGroups = groupBy(diffFiles, (r) => {
      const matched = r.match(/\.(model|types|enums|smd|generated)\.[tj]s/);
      return matched![1];
    }) as unknown as DiffGroups;

    // 변경된 파일들을 타입별로 분리하여 각 타입별 액션 처리
    const diffTypes = Object.keys(diffGroups);

    // 트리거: smd
    // 액션: 스키마 생성
    if (diffTypes.includes("smd")) {
      console.log("// 액션: 스키마 생성");
      const smdIds = this.getSMDIdFromPath(diffGroups["smd"]);
      await this.actionGenerateSchemas(smdIds);
    }

    // 트리거: types, enums, generated 변경시
    // 액션: 파일 싱크 types, enums, generated
    if (
      diffTypes.includes("types") ||
      diffTypes.includes("enums") ||
      diffTypes.includes("generated")
    ) {
      console.log("// 액션: 파일 싱크 types / enums / generated");

      const tsPaths = [
        ...(diffGroups["types"] ?? []),
        ...(diffGroups["enums"] ?? []),
        ...(diffGroups["generated"] ?? []),
      ].map((p) => p.replace("/dist/", "/src/").replace(".js", ".ts"));
      await this.actionSyncFilesToTargets(tsPaths);
    }

    // 트리거: model
    if (diffTypes.includes("model")) {
      const smdIds = this.getSMDIdFromPath(diffGroups["model"]);

      console.log("// 액션: 서비스 생성");
      await this.actionGenerateServices(smdIds);

      console.log("// 액션: HTTP파일 생성");
      await this.actionGenerateHttps(smdIds);
    }

    // 저장
    await this.saveChecksums(currentChecksums);
  }

  getSMDIdFromPath(filePaths: string[]): string[] {
    return filePaths.map((p) => {
      const matched = p.match(/application\/(.+)\//);
      return camelize(matched![1].replace(/\-/g, "_"));
    });
  }

  async actionGenerateSchemas(smdIds: string[]): Promise<string[]> {
    return (
      await Promise.all(
        smdIds.map(async (smdId) =>
          this.generateTemplate(
            "generated",
            {
              smdId,
            },
            {
              overwrite: true,
            }
          )
        )
      )
    )
      .flat()
      .flat();
  }

  async actionGenerateServices(smdIds: string[]): Promise<string[]> {
    return (
      await Promise.all(
        smdIds.map(async (smdId) =>
          this.generateTemplate(
            "service",
            {
              smdId,
            },
            {
              overwrite: true,
            }
          )
        )
      )
    )
      .flat()
      .flat();
  }

  async actionGenerateHttps(smdIds: string[]): Promise<string[]> {
    return (
      await Promise.all(
        smdIds.map(async (smdId) =>
          this.generateTemplate(
            "generated_http",
            {
              smdId,
            },
            {
              overwrite: true,
            }
          )
        )
      )
    )
      .flat()
      .flat();
  }

  async copyFileWithReplaceCoreToShared(fromPath: string, toPath: string) {
    if (!existsSync(fromPath)) {
      return;
    }

    const oldFileContent = readFileSync(fromPath).toString();
    const newFileContent = oldFileContent
      .replace(/from "sonamu"/g, `from "../sonamu.shared"`)
      .replace(
        /\/\* BEGIN- Server-side Only \*\/[\s\S]*\/\* END Server-side Only \*\/\n*/g,
        ""
      );
    return writeFile(toPath, newFileContent);
  }

  async actionSyncFilesToTargets(tsPaths: string[]): Promise<string[]> {
    return (
      await Promise.all(
        this.config.targets.map(async (target) =>
          Promise.all(
            tsPaths.map(async (src) => {
              const dst = src
                .replace("/api/", `/${target}/`)
                .replace("/application/", "/services/");
              const dir = dirname(dst);
              if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
              }
              await this.copyFileWithReplaceCoreToShared(src, dst);
              return dst;
            })
          )
        )
      )
    ).flat();
  }

  async getCurrentChecksums(): Promise<PathAndChecksum[]> {
    const PatternGroup: GlobPattern = {
      /* TS 체크 */
      types: this.config.appRootPath + "/api/src/application/**/*.types.ts",
      enums: this.config.appRootPath + "/api/src/application/**/*.enums.ts",
      generated:
        this.config.appRootPath + "/api/src/application/**/*.generated.ts",
      /* compiled-JS 체크 */
      model: this.config.appRootPath + "/api/dist/application/**/*.model.js",
      smd: this.config.appRootPath + "/api/dist/application/**/*.smd.js",
    };

    const filePaths = (
      await Promise.all(
        Object.entries(PatternGroup).map(async ([_fileType, pattern]) => {
          return globAsync(pattern);
        })
      )
    )
      .flat()
      .sort();

    const fileChecksums: {
      path: string;
      checksum: string;
    }[] = await Promise.all(
      filePaths.map(async (filePath) => {
        return {
          path: filePath,
          checksum: await this.getChecksumOfFile(filePath),
        };
      })
    );
    return fileChecksums;
  }

  async getPreviousChecksums(): Promise<PathAndChecksum[]> {
    if (existsSync(this.config.checksumsPath) === false) {
      return [];
    }

    const previousChecksums = (await readJSON(
      this.config.checksumsPath
    )) as PathAndChecksum[];
    return previousChecksums;
  }

  async saveChecksums(checksums: PathAndChecksum[]): Promise<void> {
    await writeJSON(this.config.checksumsPath, checksums);
    console.debug("checksum saved", this.config.checksumsPath);
  }

  async getChecksumOfFile(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash("sha1");
      const input = fs.createReadStream(filePath);
      input.on("error", reject);
      input.on("data", function (chunk: any) {
        hash.update(chunk);
      });
      input.on("close", function () {
        resolve(hash.digest("hex"));
      });
    });
  }

  async readApisFromFile(filePath: string) {
    const sourceFile = ts.createSourceFile(
      filePath,
      readFileSync(filePath).toString(),
      ts.ScriptTarget.Latest
    );

    const methods: Omit<ExtendedApi, "path" | "options">[] = [];
    let modelName: string = "UnknownModel";
    let methodName: string = "unknownMethod";
    const visitor = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        if (node.name && ts.isIdentifier(node.name)) {
          modelName = node.name.escapedText.toString().replace(/Class$/, "");
        }
      }
      if (ts.isMethodDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          methodName = node.name.escapedText.toString();
        }

        const typeParameters: ApiParamType.TypeParam[] = (
          node.typeParameters ?? []
        ).map((typeParam) => {
          const tp = typeParam as ts.TypeParameterDeclaration;

          return {
            t: "type-param",
            id: tp.name.escapedText.toString(),
            constraint: tp.constraint
              ? this.resolveTypeNode(tp.constraint)
              : undefined,
          };
        });
        const parameters: ApiParam[] = node.parameters.map(
          (paramDec, index) => {
            const defaultDef = this.printNode(paramDec.initializer, sourceFile);

            return this.resolveParamDec(
              {
                name: paramDec.name,
                type: paramDec.type as ts.TypeNode,
                optional:
                  paramDec.questionToken !== undefined ||
                  paramDec.initializer !== undefined,
                defaultDef,
              },
              index
            );
          }
        );
        const returnType = this.resolveTypeNode(node.type!);

        methods.push({
          modelName,
          methodName,
          typeParameters,
          parameters,
          returnType,
        });
      }
      ts.forEachChild(node, visitor);
    };
    visitor(sourceFile);

    if (methods.length === 0) {
      return [];
    }

    // 현재 파일의 등록된 API 필터
    const currentModelApis = registeredApis.filter((api) => {
      return methods.find(
        (method) =>
          method.modelName === api.modelName &&
          method.methodName === api.methodName
      );
    });

    // 등록된 API에 현재 메소드 타입 정보 확장
    const extendedApis = currentModelApis.map((api) => {
      const foundMethod = methods.find(
        (method) =>
          method.modelName === api.modelName &&
          method.methodName === api.methodName
      );
      return {
        ...api,
        typeParameters: foundMethod!.typeParameters,
        parameters: foundMethod!.parameters,
        returnType: foundMethod!.returnType,
      };
    });
    return extendedApis;
  }

  resolveTypeNode(typeNode: ts.TypeNode): ApiParamType {
    switch (typeNode?.kind) {
      case ts.SyntaxKind.AnyKeyword:
        return "any";
      case ts.SyntaxKind.UnknownKeyword:
        return "unknown";
      case ts.SyntaxKind.StringKeyword:
        return "string";
      case ts.SyntaxKind.NumberKeyword:
        return "number";
      case ts.SyntaxKind.BooleanKeyword:
        return "boolean";
      case ts.SyntaxKind.UndefinedKeyword:
        return "undefined";
      case ts.SyntaxKind.NullKeyword:
        return "null";
      case ts.SyntaxKind.VoidKeyword:
        return "void";
      case ts.SyntaxKind.LiteralType:
        const literal = (typeNode as ts.LiteralTypeNode).literal;
        if (ts.isStringLiteral(literal)) {
          return {
            t: "string-literal",
            value: literal.text,
          };
        } else if (ts.isNumericLiteral(literal)) {
          return {
            t: "numeric-literal",
            value: Number(literal.text),
          };
        } else {
          if (literal.kind === ts.SyntaxKind.NullKeyword) {
            return "null";
          } else if (literal.kind === ts.SyntaxKind.UndefinedKeyword) {
            return "undefined";
          } else if (literal.kind === ts.SyntaxKind.TrueKeyword) {
            return "true";
          } else if (literal.kind === ts.SyntaxKind.FalseKeyword) {
            return "false";
          }
          throw new Error("알 수 없는 리터럴");
        }
      case ts.SyntaxKind.ArrayType:
        const arrNode = typeNode as ts.ArrayTypeNode;
        return {
          t: "array",
          elementsType: this.resolveTypeNode(arrNode.elementType),
        };
      case ts.SyntaxKind.TypeLiteral:
        const literalNode = typeNode as ts.TypeLiteralNode;
        return {
          t: "object",
          props: literalNode.members.map((member) => {
            if (ts.isIndexSignatureDeclaration(member)) {
              const res = this.resolveParamDec({
                name: member.parameters[0].name as ts.Identifier,
                type: member.parameters[0].type as ts.TypeNode,
              });

              return this.resolveParamDec({
                name: {
                  escapedText: `[${res.name}${res.optional ? "?" : ""}: ${
                    res.type
                  }]`,
                } as ts.Identifier,
                type: member.type as ts.TypeNode,
              });
            } else {
              return this.resolveParamDec({
                name: (member as ts.PropertySignature).name as ts.Identifier,
                type: (member as ts.PropertySignature).type as ts.TypeNode,
              });
            }
          }),
        };
      case ts.SyntaxKind.TypeReference:
        return {
          t: "ref",
          id: (
            (typeNode as ts.TypeReferenceNode).typeName as ts.Identifier
          ).escapedText.toString(),
          args: (typeNode as ts.TypeReferenceNode).typeArguments?.map(
            (typeArg) => this.resolveTypeNode(typeArg)
          ),
        };
      case ts.SyntaxKind.UnionType:
        return {
          t: "union",
          types: (typeNode as ts.UnionTypeNode).types.map((type) =>
            this.resolveTypeNode(type)
          ),
        };
      case ts.SyntaxKind.IntersectionType:
        return {
          t: "intersection",
          types: (typeNode as ts.IntersectionTypeNode).types.map((type) =>
            this.resolveTypeNode(type)
          ),
        };
      case ts.SyntaxKind.IndexedAccessType:
        return {
          t: "indexed-access",
          object: this.resolveTypeNode(
            (typeNode as ts.IndexedAccessTypeNode).objectType
          ),
          index: this.resolveTypeNode(
            (typeNode as ts.IndexedAccessTypeNode).indexType
          ),
        };
      case ts.SyntaxKind.TupleType:
        if (ts.isTupleTypeNode(typeNode)) {
          return {
            t: "tuple-type",
            elements: typeNode.elements.map((elem) =>
              this.resolveTypeNode(elem)
            ),
          };
        }
        break;
    }

    console.debug(typeNode);
    throw new Error(`알 수 없는 SyntaxKind ${typeNode.kind}`);
  }

  resolveParamDec = (
    paramDec: {
      name: ts.BindingName;
      type: ts.TypeNode;
      optional?: boolean;
      defaultDef?: string;
    },
    index: number = 0
  ): ApiParam => {
    const name = paramDec.name as ts.Identifier;
    const type = this.resolveTypeNode(paramDec.type);

    if (name === undefined) {
      console.log({ name, type, paramDec });
    }

    return {
      name: name.escapedText ? name.escapedText.toString() : `nonameAt${index}`,
      type,
      optional: paramDec.optional === true,
      defaultDef: paramDec?.defaultDef,
    };
  };

  printNode(
    node: ts.Node | undefined,
    sourceFile: ts.SourceFile
  ): string | undefined {
    if (node === undefined) {
      return undefined;
    }

    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
  }

  async autoloadApis(basePath: string) {
    const pathPattern = path.join(
      basePath,
      "api/src/application/**/*.model.ts"
    );
    // console.debug(chalk.yellow(`autoload:APIs @ ${pathPattern}`));

    const filePaths = await globAsync(pathPattern);
    const result = await Promise.all(
      filePaths.map((filePath) => this.readApisFromFile(filePath))
    );
    this.apis = result.flat();
    return this.apis;
  }

  async autoloadModels(
    basePath: string
  ): Promise<{ [modelName: string]: unknown }> {
    const pathPattern = path.join(
      basePath,
      "api/dist/application/**/*.model.js"
    );
    // console.debug(chalk.yellow(`autoload:models @ ${pathPattern}`));

    const filePaths = await globAsync(pathPattern);
    const modules = await importMultiple(filePaths);
    const functions = modules
      .map(({ imported }) => Object.entries(imported))
      .flat();
    return Object.fromEntries(
      functions.filter(([name]) => name.endsWith("Model"))
    );
  }

  async autoloadTypes(
    basePath: string
  ): Promise<{ [typeName: string]: z.ZodObject<any> }> {
    if (Object.keys(this.types).length > 0) {
      return this.types;
    }

    const pathPatterns = [
      path.join(basePath, "api/dist/application/**/*.types.js"),
      path.join(basePath, "api/dist/application/**/*.enums.js"),
      path.join(basePath, "api/dist/application/**/*.generated.js"),
    ];
    // console.debug(chalk.magenta(`autoload:types @ ${pathPatterns.join("\n")}`));

    const filePaths = (
      await Promise.all(pathPatterns.map((pattern) => globAsync(pattern)))
    ).flat();
    const modules = await importMultiple(filePaths);
    const functions = modules
      .map(({ imported }) => Object.entries(imported))
      .flat();
    this.types = Object.fromEntries(
      functions.filter(([, f]) => f instanceof z.ZodType)
    ) as typeof this.types;
    return this.types;
  }

  getTemplate(key: TemplateKey): Template {
    if (key === "smd") {
      return new Template__smd();
    } else if (key === "init_enums") {
      return new Template__init_enums();
    } else if (key === "init_types") {
      return new Template__init_types();
    } else if (key === "init_generated") {
      return new Template__init_generated();
    } else if (key === "generated") {
      return new Template__generated();
    } else if (key === "generated_http") {
      return new Template__generated_http();
    } else if (key === "model") {
      return new Template__model();
    } else if (key === "model_test") {
      return new Template__model_test();
    } else if (key === "service") {
      return new Template__service();
    } else if (key === "view_list") {
      return new Template__view_list();
    } else if (key === "view_list_columns") {
      return new Template__view_list_columns();
    } else if (key === "view_search_input") {
      return new Template__view_search_input();
    } else if (key === "view_form") {
      return new Template__view_form();
    } else if (key === "view_id_all_select") {
      return new Template__view_id_all_select();
    } else if (key === "view_id_async_select") {
      return new Template__view_id_async_select();
    } else if (key === "view_enums_select") {
      return new Template__view_enums_select();
    } else if (key === "view_enums_dropdown") {
      return new Template__view_enums_dropdown();
    } else if (key === "view_enums_buttonset") {
      return new Template__view_enums_buttonset();
    } else {
      throw new BadRequestException(`잘못된 템플릿 키 ${key}`);
    }
  }

  async renderTemplate(
    key: TemplateKey,
    options: TemplateOptions[TemplateKey]
  ): Promise<PathAndCode[]> {
    const template: Template = this.getTemplate(key);

    let extra: unknown[] = [];
    if (key === "service" || key === "generated_http") {
      // service 필요 정보 (API 리스트)
      const smd = SMDManager.get(options.smdId);
      const modelTsPath = `${path.resolve(
        this.config.appRootPath,
        "api/src/application"
      )}/${smd.names.fs}/${smd.names.fs}.model.ts`;
      extra = [await this.readApisFromFile(modelTsPath)];
    } else if (key === "view_list" || key === "model") {
      // view_list 필요 정보 (컬럼 노드, 리스트파라미터 노드)
      const columnsNode = await this.getColumnsNode(options.smdId, "A");
      const listParamsZodType = await this.getZodTypeById(
        `${options.smdId}ListParams`
      );
      const listParamsNode = this.zodTypeToRenderingNode(listParamsZodType);
      extra = [columnsNode, listParamsNode];
    } else if (key === "view_form") {
      // view_form 필요 정보 (세이브파라미터 노드)
      const saveParamsZodType = await this.getZodTypeById(
        `${options.smdId}SaveParams`
      );
      const saveParamsNode = this.zodTypeToRenderingNode(saveParamsZodType);
      extra = [saveParamsNode];
    }

    const rendered = template.render(options, ...extra);
    const resolved = this.resolveRenderedTemplate(key, rendered);

    let preTemplateResolved: PathAndCode[] = [];
    if (rendered.preTemplates) {
      preTemplateResolved = (
        await Promise.all(
          rendered.preTemplates.map(({ key, options }) => {
            return this.renderTemplate(key, options);
          })
        )
      ).flat();
    }

    return [resolved, ...preTemplateResolved];
  }

  resolveRenderedTemplate(
    key: TemplateKey,
    result: RenderedTemplate
  ): PathAndCode {
    const { target, path: filePath, body, importKeys, customHeaders } = result;

    // import 할 대상의 대상 path 추출
    const importDefs = importKeys
      .reduce(
        (r, importKey) => {
          const modulePath = SMDManager.getModulePath(importKey);
          let importPath = modulePath;
          if (modulePath.includes("/")) {
            importPath = wrapIf(
              path.relative(path.dirname(filePath), modulePath),
              (p) => [p.startsWith(".") === false, "./" + p]
            );
          }

          // 같은 파일에서 import 하는 경우 keys 로 나열 처리
          const existsOne = r.find(
            (importDef) => importDef.from === importPath
          );
          if (existsOne) {
            existsOne.keys = uniq(existsOne.keys.concat(importKey));
          } else {
            r.push({
              keys: [importKey],
              from: importPath,
            });
          }
          return r;
        },
        [] as {
          keys: string[];
          from: string;
        }[]
      )
      // 셀프 참조 방지
      .filter(
        (importDef) =>
          filePath.endsWith(importDef.from.replace("./", "") + ".ts") === false
      );

    // 커스텀 헤더 포함하여 헤더 생성
    const header = [
      ...(customHeaders ?? []),
      ...importDefs.map(
        (importDef) =>
          `import { ${importDef.keys.join(", ")} } from '${importDef.from}'`
      ),
    ].join("\n");

    const formatted =
      key === "generated_http"
        ? [header, body].join("\n\n")
        : prettier.format([header, body].join("\n\n"), {
            parser: "typescript",
          });

    return {
      path: target + "/" + filePath,
      code: formatted,
    };
  }

  async writeCodeToPath(pathAndCode: PathAndCode): Promise<string[]> {
    const { appRootPath, targets } = this.config;
    const filePath = `${appRootPath}/${pathAndCode.path}`;

    const dstFilePaths = uniq(
      targets.map((target) => filePath.replace("/:target/", `/${target}/`))
    );
    return await Promise.all(
      dstFilePaths.map(async (dstFilePath) => {
        const dir = path.dirname(dstFilePath);
        if (existsSync(dir) === false) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(dstFilePath, pathAndCode.code);
        console.log("GENERATED ", chalk.blue(dstFilePath));
        return dstFilePath;
      })
    );
  }

  async generateTemplate(
    key: TemplateKey,
    templateOptions: any,
    _generateOptions?: GenerateOptions
  ) {
    const generateOptions = {
      overwrite: false,
      ..._generateOptions,
    };

    // 키 children
    let keys: TemplateKey[] = [key];
    if (key === "smd") {
      keys = ["smd", "init_enums", "init_generated", "init_types"];
    }

    // 템플릿 렌더
    const pathAndCodes = (
      await Promise.all(
        keys.map(async (key) => {
          return this.renderTemplate(key, templateOptions);
        })
      )
    ).flat();

    /*
    overwrite가 true일 때
    - 생각하지 않고 그냥 다 덮어씀
    overwrite가 false일 때
     - 옵션1 (현재구현): 그냥 파일 하나라도 있으면 코드 생성 안함
     - 옵션2 : 있는 파일은 전부 그대로 두고 없는 파일만 싹 생성함
     - 옵션3 : 메인 파일만 그대로 두고, 파생 파일은 전부 생성함 => 이게 맞지 않나?
    */

    let filteredPathAndCodes: PathAndCode[] = [];
    if (generateOptions.overwrite === true) {
      filteredPathAndCodes = pathAndCodes;
    } else {
      filteredPathAndCodes = pathAndCodes.filter((pathAndCode, index) => {
        if (index === 0) {
          const { appRootPath, targets } = this.config;
          const filePath = `${appRootPath}/${pathAndCode.path}`;
          const dstFilePaths = targets.map((target) =>
            filePath.replace("/:target/", `/${target}/`)
          );
          return dstFilePaths.every((dstPath) => existsSync(dstPath) === false);
        } else {
          return true;
        }
      });
      if (filteredPathAndCodes.length === 0) {
        throw new AlreadyProcessedException(
          "이미 경로에 모든 파일이 존재합니다."
        );
      }
    }

    return Promise.all(
      filteredPathAndCodes.map((pathAndCode) =>
        this.writeCodeToPath(pathAndCode)
      )
    );
  }

  checkExists(
    smdId: string,
    enums: {
      [name: string]: z.ZodEnum<any>;
    }
  ): Record<`${TemplateKey}${string}`, boolean> {
    const keys: TemplateKey[] = TemplateKey.options;
    const names = SMDManager.getNamesFromId(smdId);
    const enumsKeys = Object.keys(enums).filter(
      (name) => name !== names.constant
    );

    return keys.reduce((result, key) => {
      const tpl = this.getTemplate(key);
      if (key.startsWith("view_enums")) {
        enumsKeys.map((componentId) => {
          const { target, path: p } = tpl.getTargetAndPath(names, componentId);
          result[`${key}__${componentId}`] = existsSync(
            path.join(this.config.appRootPath, target, p)
          );
        });
        return result;
      }

      const { target, path: p } = tpl.getTargetAndPath(names);
      if (target.includes(":target")) {
        this.config.targets.map((t) => {
          result[`${key}__${t}`] = existsSync(
            path.join(this.config.appRootPath, target.replace(":target", t), p)
          );
        });
      } else {
        result[key] = existsSync(path.join(this.config.appRootPath, target, p));
      }

      return result;
    }, {} as Record<`${TemplateKey}${string}`, boolean>);
  }

  async getZodTypeById(zodTypeId: string): Promise<z.ZodTypeAny> {
    const modulePath = SMDManager.getModulePath(zodTypeId);
    const moduleAbsPath = path.join(
      this.config.appRootPath,
      "api",
      "dist",
      "application",
      modulePath + ".js"
    );
    const importPath = "./" + path.relative(__dirname, moduleAbsPath);
    const imported = await import(importPath);

    if (!imported[zodTypeId]) {
      throw new Error(`존재하지 않는 zodTypeId ${zodTypeId}`);
    }
    return imported[zodTypeId].describe(zodTypeId);
  }

  async propNodeToZodType(propNode: SMDPropNode): Promise<z.ZodTypeAny> {
    if (propNode.nodeType === "plain") {
      return this.propToZodType(propNode.prop);
    } else if (propNode.nodeType === "array") {
      if (propNode.prop === undefined) {
        throw new Error();
      } else if (propNode.children.length > 0) {
        return (
          await this.propNodeToZodType({
            ...propNode,
            nodeType: "object",
          })
        ).array();
      } else {
        const innerType = await this.propToZodType(propNode.prop);
        if (propNode.prop.nullable === true) {
          return z.array(innerType).nullable();
        } else {
          return z.array(innerType);
        }
      }
    } else if (propNode.nodeType === "object") {
      const obj = await propNode.children.reduce(
        async (promise, childPropNode) => {
          const result = await promise;
          result[childPropNode.prop!.name] = await this.propNodeToZodType(
            childPropNode
          );
          return result;
        },
        {} as any
      );

      if (propNode.prop?.nullable === true) {
        return z.object(obj).nullable();
      } else {
        return z.object(obj);
      }
    } else {
      throw Error;
    }
  }
  async propToZodType(prop: SMDProp): Promise<z.ZodTypeAny> {
    let zodType: z.ZodTypeAny = z.unknown();
    if (isIntegerProp(prop)) {
      zodType = z.number().int();
    } else if (isBigIntegerProp(prop)) {
      zodType = z.bigint();
    } else if (isTextProp(prop)) {
      zodType = z.string().max(getTextTypeLength(prop.textType));
    } else if (isEnumProp(prop)) {
      zodType = await this.getZodTypeById(prop.id);
    } else if (isStringProp(prop)) {
      zodType = z.string().max(prop.length);
    } else if (isFloatProp(prop) || isDoubleProp(prop) || isDecimalProp(prop)) {
      zodType = z.number();
    } else if (isBooleanProp(prop)) {
      zodType = z.boolean();
    } else if (isDateProp(prop)) {
      zodType = z.string().length(10);
    } else if (isTimeProp(prop)) {
      zodType = z.string().length(8);
    } else if (isDateTimeProp(prop)) {
      zodType = SQLDateTimeString;
    } else if (isTimestampProp(prop)) {
      zodType = SQLDateTimeString;
    } else if (isJsonProp(prop)) {
      if (prop.as instanceof z.ZodType) {
        zodType = prop.as;
      } else {
        zodType = await this.getZodTypeById(prop.as.ref);
      }
    } else if (isUuidProp(prop)) {
      zodType = z.string().uuid();
    } else if (isVirtualProp(prop)) {
      if (prop.as instanceof z.ZodType) {
        zodType = prop.as;
      } else {
        zodType = await this.getZodTypeById(prop.as.ref);
      }
    } else if (isRelationProp(prop)) {
      if (
        isBelongsToOneRelationProp(prop) ||
        (isOneToOneRelationProp(prop) && prop.hasJoinColumn)
      ) {
        zodType = z.number().int();
        throw new Error("여기를 들어온다고?");
      }
    } else {
      throw new Error(`prop을 zodType으로 변환하는데 실패 ${prop}}`);
    }

    if ((prop as { unsigned?: boolean }).unsigned) {
      zodType = (zodType as z.ZodNumber).nonnegative();
    }
    if (prop.nullable) {
      zodType = zodType.nullable();
    }

    return zodType;
  }

  resolveRenderType(
    key: string,
    zodType: z.ZodTypeAny
  ): RenderingNode["renderType"] {
    if (zodType instanceof z.ZodString) {
      if (key.includes("img") || key.includes("image")) {
        return "string-image";
      } else if (zodType.description === "SQLDateTimeString") {
        return "string-datetime";
      } else {
        return "string-plain";
      }
    } else if (zodType instanceof z.ZodNumber) {
      if (key === "id") {
        return "number-id";
      } else if (key.endsWith("_id")) {
        return "number-fk_id";
      } else {
        return "number-plain";
      }
    } else if (zodType instanceof z.ZodBoolean) {
      return "boolean";
    } else if (zodType instanceof z.ZodEnum) {
      return "enums";
    } else if (zodType instanceof z.ZodAny) {
      return "string-plain";
    } else {
      throw new Error(`타입 파싱 불가 ${key} ${zodType._def.typeName}`);
    }
  }
  zodTypeToRenderingNode(
    zodType: z.ZodTypeAny,
    baseKey: string = "root"
  ): RenderingNode {
    const def = {
      name: baseKey,
      label: camelize(baseKey, false),
      zodType,
    };
    if (zodType instanceof z.ZodObject) {
      const columnKeys = Object.keys(zodType.shape);
      const children = columnKeys.map((key) => {
        const innerType = zodType.shape[key];
        return this.zodTypeToRenderingNode(innerType, key);
      });
      return {
        ...def,
        renderType: "object",
        children,
      };
    } else if (zodType instanceof z.ZodArray) {
      const innerType = zodType._def.type;
      if (innerType instanceof z.ZodString && baseKey.includes("images")) {
        return {
          ...def,
          renderType: "array-images",
        };
      }
      return {
        ...def,
        renderType: "array",
        element: this.zodTypeToRenderingNode(innerType, baseKey),
      };
    } else if (zodType instanceof z.ZodUnion) {
      const optionNodes = zodType._def.options.map((opt: z.ZodTypeAny) =>
        this.zodTypeToRenderingNode(opt, baseKey)
      );
      // TODO: ZodUnion이 들어있는 경우 핸들링
      return optionNodes[0];
    } else if (zodType instanceof z.ZodOptional) {
      return {
        ...this.zodTypeToRenderingNode(zodType._def.innerType, baseKey),
        optional: true,
      };
    } else if (zodType instanceof z.ZodNullable) {
      return {
        ...this.zodTypeToRenderingNode(zodType._def.innerType, baseKey),
        nullable: true,
      };
    } else {
      return {
        ...def,
        renderType: this.resolveRenderType(baseKey, zodType),
      };
    }
  }

  async getColumnsNode(smdId: string, subsetKey: string) {
    const smd = await SMDManager.get(smdId);
    const subsetA = smd.subsets[subsetKey];
    if (subsetA === undefined) {
      throw new ServiceUnavailableException("SubsetA 가 없습니다.");
    }
    const propNodes = smd.fieldExprsToPropNodes(subsetA);
    const rootPropNode: SMDPropNode = {
      nodeType: "object",
      children: propNodes,
    };

    const columnsZodType = (await this.propNodeToZodType(
      rootPropNode
    )) as z.ZodObject<any>;

    const columnsNode = this.zodTypeToRenderingNode(columnsZodType);
    columnsNode.children = columnsNode.children!.map((child) => {
      if (child.renderType === "object") {
        const pickedCol = child.children!.find((cc) =>
          ["title", "name"].includes(cc.name)
        );
        if (pickedCol) {
          return {
            ...child,
            renderType: "object-pick",
            config: {
              picked: pickedCol.name,
            },
          };
        } else {
          return child;
        }
      } else if (
        child.renderType === "array" &&
        child.element &&
        child.element.renderType === "object"
      ) {
        const pickedCol = child.element!.children!.find((cc) =>
          ["title", "name"].includes(cc.name)
        );
        if (pickedCol) {
          return {
            ...child,
            element: {
              ...child.element,
              renderType: "object-pick",
              config: {
                picked: pickedCol.name,
              },
            },
          };
        } else {
          return child;
        }
      }
      return child;
    });

    return columnsNode;
  }
}