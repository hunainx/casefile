import type { MatrixRole, Permission, PolicyOutcome } from "../src/types.js";
import { PERMISSIONS_MATRIX, MATRIX_ROLES } from "../src/matrix.js";

export interface MatrixFixtureEntry {
  permission: Permission;
  role: MatrixRole;
  expectedOutcome: PolicyOutcome;
}

export const MATRIX_FIXTURE: MatrixFixtureEntry[] = [];

for (const [perm, roleMap] of Object.entries(PERMISSIONS_MATRIX) as [Permission, Record<MatrixRole, PolicyOutcome>][]) {
  for (const role of MATRIX_ROLES) {
    MATRIX_FIXTURE.push({
      permission: perm,
      role,
      expectedOutcome: roleMap[role],
    });
  }
}
