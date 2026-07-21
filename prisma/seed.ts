/// <reference types="node" />
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Override via env vars in any real environment — these defaults exist
  // purely so local/dev setup works out of the box.
  const email = process.env.SUPER_ADMIN_EMAIL || "superadmin@cctv.com";
  const password = process.env.SUPER_ADMIN_PASSWORD || "SuperAdmin@1234";

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log("⚠️  Super Admin user already exists, skipping seed.");
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      role: "SUPER_ADMIN",
      isActive: true,
    },
  });

  console.log(`✅ Super Admin created: ${email} / ${password}`);
  console.log("⚠️  Change this password immediately after first login — via");
  console.log("    PATCH /api/users/me/password.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });