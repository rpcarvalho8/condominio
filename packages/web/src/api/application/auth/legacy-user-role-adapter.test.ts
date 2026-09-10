import { describe, expect, test } from "bun:test";
import { isLegacyAdminRole, readLegacyUserRole } from "./legacy-user-role-adapter";

describe("legacy user.role adapter", () => {
  test("lê o role plano do better-auth sem o promover a Membership", () => {
    expect(readLegacyUserRole({ id: "u1", role: "admin" })).toBe("admin");
    expect(readLegacyUserRole({ id: "u1", role: "condómino" })).toBe("condómino");
    expect(isLegacyAdminRole({ id: "u1", role: "admin" })).toBe(true);
    expect(isLegacyAdminRole({ id: "u1", role: "Admin" })).toBe(false);
    expect(isLegacyAdminRole({ id: "u1", role: "condómino" })).toBe(false);
    expect(isLegacyAdminRole(null)).toBe(false);
  });
});
