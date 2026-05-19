// ============================================================
// EsimService — manual eSIM inventory & purchase logic
// ============================================================

import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateEsimProductDto, UpdateEsimProductDto, AddInventoryDto,
} from './dto/esim.dto';

@Injectable()
export class EsimService {
  private readonly logger = new Logger(EsimService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Public / User ─────────────────────────────────────────

  /** List active products with stock count */
  async listProducts() {
    const products = await this.prisma.esimProduct.findMany({
      where: { isActive: true },
      orderBy: [{ country: 'asc' }, { gb: 'asc' }],
    });

    // Add stock count
    const withStock = await Promise.all(
      products.map(async (p) => {
        const stock = await this.prisma.esimInventory.count({
          where: { productId: p.id, isSold: false },
        });
        return { ...p, stock };
      }),
    );

    return withStock;
  }

  /** Purchase an eSIM — deducts balance and assigns a QR code */
  async purchaseEsim(userId: string, productId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Get product
      const product = await tx.esimProduct.findUnique({ where: { id: productId } });
      if (!product || !product.isActive) {
        throw new NotFoundException('eSIM product not found or inactive');
      }

      // 2. Check user balance
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found');
      if (user.balance < product.price) {
        throw new BadRequestException(
          `Insufficient balance. Need ${product.price}, have ${user.balance}`,
        );
      }

      // 3. Get available inventory (FIFO)
      const inventory = await tx.esimInventory.findFirst({
        where: { productId, isSold: false },
        orderBy: { createdAt: 'asc' },
      });
      if (!inventory) {
        const pendingOrder = await tx.esimOrder.create({
          data: { userId, productId, inventoryId: null, price: product.price, status: 'PENDING' },
          include: { product: true },
        });
        return { ...pendingOrder, inventory: null, isPending: true };
      }

      // 4. Mark inventory as sold
      await tx.esimInventory.update({
        where: { id: inventory.id },
        data: { isSold: true, soldAt: new Date() },
      });

      // 5. Deduct balance
      const balanceAfter = user.balance - product.price;
      await tx.user.update({
        where: { id: userId },
        data: { balance: balanceAfter },
      });

      // 6. Record transaction
      await tx.transaction.create({
        data: {
          userId,
          type: 'DEBIT',
          amount: -product.price,
          balanceAfter,
          description: `eSIM: ${product.name} - ${product.country}`,
        },
      });

      // 7. Create eSIM order
      const order = await tx.esimOrder.create({
        data: {
          userId,
          productId,
          inventoryId: inventory.id,
          price: product.price,
          status: 'COMPLETED',
        },
        include: { product: true, inventory: true },
      });

      this.logger.log(`eSIM purchased: user=${userId} product=${productId}`);
      return order;
    });
  }

  /** List user's eSIM orders */
  async listUserOrders(userId: string) {
    return this.prisma.esimOrder.findMany({
      where: { userId },
      include: { product: true, inventory: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Get single eSIM order (with QR code) */
  async getUserOrder(userId: string, orderId: string) {
    const order = await this.prisma.esimOrder.findFirst({
      where: { id: orderId, userId },
      include: { product: true, inventory: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ── Admin ─────────────────────────────────────────────────

  async adminListProducts() {
    const products = await this.prisma.esimProduct.findMany({
      orderBy: [{ country: 'asc' }, { gb: 'asc' }],
    });
    return Promise.all(
      products.map(async (p) => {
        const total = await this.prisma.esimInventory.count({ where: { productId: p.id } });
        const sold  = await this.prisma.esimInventory.count({ where: { productId: p.id, isSold: true } });
        return { ...p, totalStock: total, soldStock: sold, availableStock: total - sold };
      }),
    );
  }

  async createProduct(dto: CreateEsimProductDto) {
    return this.prisma.esimProduct.create({ data: dto });
  }

  async updateProduct(id: string, dto: UpdateEsimProductDto) {
    return this.prisma.esimProduct.update({ where: { id }, data: dto });
  }

  async deleteProduct(id: string) {
    await this.prisma.esimProduct.delete({ where: { id } });
    return { deleted: true };
  }

  async addInventory(dto: AddInventoryDto) {
    const product = await this.prisma.esimProduct.findUnique({
      where: { id: dto.productId },
    });
    if (!product) throw new NotFoundException('Product not found');

    return this.prisma.esimInventory.create({
      data: {
        productId: dto.productId,
        qrCodeData: dto.qrCodeData,
        activationCode: dto.activationCode,
      },
    });
  }

  async listInventory(productId: string) {
    return this.prisma.esimInventory.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteInventory(id: string) {
    const item = await this.prisma.esimInventory.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Inventory item not found');
    if (item.isSold) throw new BadRequestException('Cannot delete sold inventory');
    await this.prisma.esimInventory.delete({ where: { id } });
    return { deleted: true };
  }

  async adminListOrders(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      this.prisma.esimOrder.findMany({
        skip, take: limit,
        include: { product: true, user: { select: { id: true, email: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.esimOrder.count(),
    ]);
    return { orders, total, page, limit };
  }
}
