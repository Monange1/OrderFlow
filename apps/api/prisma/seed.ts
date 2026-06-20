import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("password123", 10);

  await prisma.user.upsert({
    where: { email: "admin@restaurant.test" },
    update: {
      name: "Admin",
      role: "ADMIN",
      active: true,
      passwordHash,
    },
    create: {
      name: "Admin",
      email: "admin@restaurant.test",
      role: "ADMIN",
      active: true,
      passwordHash,
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("Seed complete. Admin password: password123");
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
