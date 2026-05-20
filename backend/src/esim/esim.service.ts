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

    // 3. Check inventory
    const inventory = await tx.esimInventory.findFirst({
      where: { productId, isSold: false },
      orderBy: { createdAt: 'asc' },
    });

    // 4. Deduct balance
    const balanceAfter = user.balance - product.price;
    await tx.user.update({
      where: { id: userId },
      data: { balance: balanceAfter },
    });

    // 5. Record transaction
    await tx.transaction.create({
      data: {
        userId,
        type: 'DEBIT',
        amount: -product.price,
        balanceAfter,
        description: `eSIM: ${product.name} - ${product.country}`,
      },
    });

    // 6. Manual fulfillment flow (no stock)
    if (!inventory) {
      const order = await tx.esimOrder.create({
        data: {
          userId,
          productId,
          price: product.price,
          status: 'PENDING',
        },
        include: { product: true },
      });
      this.logger.log(`eSIM PENDING (manual): user=${userId} product=${productId}`);
      return { ...order, manualFulfillment: true };
    }

    // 7. Auto fulfillment (stock available)
    await tx.esimInventory.update({
      where: { id: inventory.id },
      data: { isSold: true, soldAt: new Date() },
    });

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
