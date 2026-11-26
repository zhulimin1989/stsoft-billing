import * as fs from 'fs';
import * as path from 'path';

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith('.controller.ts') ? [fullPath] : [];
  });
}

describe('admin controller guard coverage', () => {
  it('mounts AdminPermissionGuard on controllers that require admin permissions', () => {
    const srcRoot = path.resolve(__dirname, '../../');
    const offenders = walk(srcRoot)
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        const requiresAdminPermission = /@RequireAdminPermission\s*\(/.test(source);
        const mountsPermissionGuard =
          /@UseGuards\([\s\S]*AdminJwtAuthGuard[\s\S]*AdminPermissionGuard[\s\S]*\)/.test(source);
        const mountsInternalAdminGuard =
          /@UseGuards\([\s\S]*BillingInternalGuard[\s\S]*AdminPermissionGuard[\s\S]*\)/.test(source);
        return requiresAdminPermission && !mountsPermissionGuard && !mountsInternalAdminGuard;
      })
      .map((file) => path.relative(srcRoot, file));

    expect(offenders).toEqual([]);
  });
});
