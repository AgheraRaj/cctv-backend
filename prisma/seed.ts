/// <reference types="node" />
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcrypt'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

async function main() {
  const existing = await prisma.user.findUnique({
    where: { email: 'admin@cctv.com' },
  })

  if (existing) {
    console.log('⚠️  Admin user already exists, skipping seed.')
    return
  }

  const hashedPassword = await bcrypt.hash('Admin@1234', 10)

  await prisma.user.create({
    data: {
      email: 'admin@cctv.com',
      password: hashedPassword,
      role: 'ADMIN',
    },
  })

  console.log('✅ Admin user created: admin@cctv.com / Admin@1234')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })