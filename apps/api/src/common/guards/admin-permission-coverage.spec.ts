import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const HTTP_METHOD_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'All',
]);

const ADMIN_PERMISSION_DECORATORS = new Set([
  'RequireAdminPermission',
  'NoAdminPermissionRequired',
]);

function controllerFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      result.push(...controllerFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
      result.push(fullPath);
    }
  }
  return result;
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function decoratorCall(decorator: ts.Decorator): ts.CallExpression | null {
  return ts.isCallExpression(decorator.expression) ? decorator.expression : null;
}

function callName(call: ts.CallExpression): string | null {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function hasDecorator(node: ts.Node, names: Set<string>): boolean {
  return decoratorsOf(node).some((decorator) => {
    const call = decoratorCall(decorator);
    return call ? names.has(callName(call) ?? '') : false;
  });
}

function usesAdminPermissionGuard(node: ts.Node): boolean {
  return decoratorsOf(node).some((decorator) => {
    const call = decoratorCall(decorator);
    if (!call) return false;
    return callName(call) === 'UseGuards' &&
      call.arguments.some((arg) => arg.getText() === 'AdminPermissionGuard');
  });
}

function methodName(member: ts.MethodDeclaration): string {
  const name = member.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText();
}

describe('admin permission metadata coverage', () => {
  it('requires every AdminPermissionGuard route to declare admin permission metadata', () => {
    const sourceRoot = join(__dirname, '../..');
    const missing: string[] = [];

    for (const file of controllerFiles(sourceRoot)) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );

      source.forEachChild((node) => {
        if (!ts.isClassDeclaration(node) || !usesAdminPermissionGuard(node)) return;
        const classHasPermissionMetadata = hasDecorator(node, ADMIN_PERMISSION_DECORATORS);

        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member)) continue;
          if (!hasDecorator(member, HTTP_METHOD_DECORATORS)) continue;
          if (classHasPermissionMetadata || hasDecorator(member, ADMIN_PERMISSION_DECORATORS)) continue;
          missing.push(`${relative(sourceRoot, file)}:${node.name?.text ?? '<anonymous>'}.${methodName(member)}`);
        }
      });
    }

    expect(missing).toEqual([]);
  });
});
