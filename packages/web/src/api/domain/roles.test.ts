import { describe, expect, test } from "bun:test";
import { canManageMemberships, isKernelRoleCode, KERNEL_ROLE_CODES } from "./roles";

describe("kernel roles", () => {
  test("seed inicial inclui Fiscalizacao e não inventa ConselhoFiscal", () => {
    expect(KERNEL_ROLE_CODES).toEqual([
      "Owner",
      "CoOwner",
      "Proxy",
      "Admin",
      "PlatformAdmin",
      "Fiscalizacao",
    ]);
    expect(isKernelRoleCode("Fiscalizacao")).toBe(true);
    expect(isKernelRoleCode("ConselhoFiscal")).toBe(false);
    expect(isKernelRoleCode("condómino")).toBe(false);
  });

  test("só Admin e PlatformAdmin gerem Memberships", () => {
    expect(canManageMemberships("Admin")).toBe(true);
    expect(canManageMemberships("PlatformAdmin")).toBe(true);
    expect(canManageMemberships("Fiscalizacao")).toBe(false);
    expect(canManageMemberships("Owner")).toBe(false);
  });
});
