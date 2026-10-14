import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';

import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { CatalogService } from './catalog.service.js';

const decimal4 = z.string().regex(/^\d+(\.\d{1,4})?$/);
const decimal6 = z.string().regex(/^\d+(\.\d{1,6})?$/);
const itemSchema = z.object({
  sku: z.string().min(1).max(80),
  barcode: z.string().trim().min(1).max(64).optional(),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().max(200).optional(),
  categoryId: z.string().uuid(),
  baseUnitId: z.string().uuid(),
  kind: z.enum(['stock', 'service', 'composite']).optional(),
  salePrice: z.string().optional(),
  purchasePrice: z.string().optional(),
  taxGroupId: z.string().uuid().optional(),
  minQty: decimal4.optional(),
  maxQty: decimal4.optional(),
  trackLot: z.boolean().optional(),
  trackSerial: z.boolean().optional(),
});
const itemUnitSchema = z.object({
  unitId: z.string().uuid(),
  /** Base units per one of this unit — 12 for a carton of a 12-piece item. */
  ratio: decimal6,
  barcode: z.string().trim().max(64).nullish(),
  salePrice: decimal4.optional(),
  purchasePrice: decimal4.optional(),
  isDefaultSale: z.boolean().optional(),
  isDefaultPurchase: z.boolean().optional(),
});
/** A component line of zero or less is not a recipe, it is a mistake. */
const positiveQty = decimal4.refine((value) => Number(value) > 0, {
  message: 'must be greater than zero',
});
const itemComponentSchema = z.object({
  componentItemId: z.string().uuid(),
  qty: positiveQty,
  unitId: z.string().uuid().optional(),
  kind: z.enum(['component', 'additive']).optional(),
  warehouseId: z.string().uuid().nullish(),
});
const itemBarcodeSchema = z.object({
  barcode: z.string().trim().min(1).max(64),
  unitId: z.string().uuid().nullish(),
});

const categorySchema = z.object({
  code: z.string().min(1).max(40),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().max(200).optional(),
  parentId: z.string().uuid().optional(),
});
const unitSchema = z.object({
  code: z.string().min(1).max(20),
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().max(120).optional(),
});
const itemPatchSchema = z.object({
  sku: z.string().min(1).max(80).optional(),
  barcode: z.string().trim().max(64).nullish(),
  nameAr: z.string().min(1).max(200).optional(),
  nameEn: z.string().max(200).nullish(),
  categoryId: z.string().uuid().optional(),
  kind: z.enum(['stock', 'service', 'composite']).optional(),
  salePrice: z.string().optional(),
  purchasePrice: z.string().optional(),
  taxGroupId: z.string().uuid().nullish(),
  showInPos: z.boolean().optional(),
  minQty: decimal4.optional(),
  maxQty: decimal4.nullish(),
  trackLot: z.boolean().optional(),
  trackSerial: z.boolean().optional(),
});
const categoryPatchSchema = z.object({
  code: z.string().min(1).max(40).optional(),
  nameAr: z.string().min(1).max(200).optional(),
  nameEn: z.string().max(200).nullish(),
  parentId: z.string().uuid().nullish(),
});
const unitPatchSchema = z.object({
  code: z.string().min(1).max(20).optional(),
  nameAr: z.string().min(1).max(120).optional(),
  nameEn: z.string().max(120).nullish(),
});
const taxGroupPatchSchema = z.object({
  nameAr: z.string().min(1).max(120).optional(),
  nameEn: z.string().max(120).nullish(),
  rate: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .optional(),
  vatAccountId: z.string().uuid().nullish(),
  isInclusiveDefault: z.boolean().optional(),
});

const taxGroupSchema = z.object({
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().max(120).optional(),
  rate: z.string().regex(/^\d+(\.\d{1,4})?$/),
  vatAccountId: z.string().uuid().optional(),
  isInclusiveDefault: z.boolean().optional(),
});

@Controller('organization/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('items') @RequiresPermission('catalog.item.view') list(@Query('q') q?: string) {
    return this.catalog.listItems(getTenantContext().tenantId, q);
  }
  @Post('items') @RequiresPermission('catalog.item.manage') create(@Body() body: unknown) {
    return this.catalog.createItem(getTenantContext().tenantId, itemSchema.parse(body));
  }
  @Patch('items/:id') @RequiresPermission('catalog.item.manage') update(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateItem(getTenantContext().tenantId, id, itemPatchSchema.parse(body));
  }
  @Delete('items/:id') @RequiresPermission('catalog.item.manage') remove(@Param('id') id: string) {
    return this.catalog.removeItem(getTenantContext().tenantId, id);
  }
  // ------------------------------------------------- وحدات القياس المتعددة

  /**
   * `GET /organization/catalog/items/:id/units` — the base unit first, then every other
   * unit this item can be counted in. The screen and the scanner both read it.
   */
  @Get('items/:id/units') @RequiresPermission('catalog.item.view') itemUnits(@Param('id') itemId: string) {
    return this.catalog.listItemUnits(getTenantContext().tenantId, itemId);
  }

  @Post('items/:id/units') @RequiresPermission('catalog.item.manage') setItemUnit(
    @Param('id') itemId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.setItemUnit(getTenantContext().tenantId, itemId, itemUnitSchema.parse(body));
  }

  @Delete('items/:id/units/:unitId') @RequiresPermission('catalog.item.manage') removeItemUnit(
    @Param('id') itemId: string,
    @Param('unitId') unitId: string,
  ) {
    return this.catalog.removeItemUnit(getTenantContext().tenantId, itemId, unitId);
  }

  // ------------------------------------------------------- الباركود المتعدد

  @Get('items/:id/barcodes') @RequiresPermission('catalog.item.view') itemBarcodes(
    @Param('id') itemId: string,
  ) {
    return this.catalog.listItemBarcodes(getTenantContext().tenantId, itemId);
  }

  @Post('items/:id/barcodes') @RequiresPermission('catalog.item.manage') addItemBarcode(
    @Param('id') itemId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.addItemBarcode(getTenantContext().tenantId, itemId, itemBarcodeSchema.parse(body));
  }

  @Delete('items/:id/barcodes/:barcode') @RequiresPermission('catalog.item.manage') removeItemBarcode(
    @Param('id') itemId: string,
    @Param('barcode') barcode: string,
  ) {
    return this.catalog.removeItemBarcode(getTenantContext().tenantId, decodeURIComponent(barcode));
  }

  // ------------------------------------------------------------ مكوّنات الصنف (BOM)

  /**
   * `GET /organization/catalog/items/:id/components` — the bill of materials, with the
   * names and units the item card and the production screen both need.
   */
  @Get('items/:id/components') @RequiresPermission('catalog.item.view') itemComponents(
    @Param('id') itemId: string,
  ) {
    return this.catalog.listItemComponents(getTenantContext().tenantId, itemId);
  }

  @Post('items/:id/components') @RequiresPermission('catalog.item.manage') setItemComponent(
    @Param('id') itemId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.setItemComponent(
      getTenantContext().tenantId,
      itemId,
      itemComponentSchema.parse(body),
    );
  }

  @Delete('items/:id/components/:componentItemId')
  @RequiresPermission('catalog.item.manage')
  removeItemComponent(
    @Param('id') itemId: string,
    @Param('componentItemId') componentItemId: string,
  ) {
    return this.catalog.removeItemComponent(getTenantContext().tenantId, itemId, componentItemId);
  }

  @Get('categories') @RequiresPermission('catalog.category.view') categories() {
    return this.catalog.listCategories(getTenantContext().tenantId);
  }
  @Post('categories') @RequiresPermission('catalog.category.manage') createCategory(@Body() body: unknown) {
    return this.catalog.createCategory(getTenantContext().tenantId, categorySchema.parse(body));
  }
  @Patch('categories/:id') @RequiresPermission('catalog.category.manage') updateCategory(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateCategory(getTenantContext().tenantId, id, categoryPatchSchema.parse(body));
  }
  @Delete('categories/:id') @RequiresPermission('catalog.category.manage') removeCategory(
    @Param('id') id: string,
  ) {
    return this.catalog.removeCategory(getTenantContext().tenantId, id);
  }
  @Get('units') @RequiresPermission('catalog.unit.view') units() {
    return this.catalog.listUnits(getTenantContext().tenantId);
  }
  @Post('units') @RequiresPermission('catalog.unit.manage') createUnit(@Body() body: unknown) {
    return this.catalog.createUnit(getTenantContext().tenantId, unitSchema.parse(body));
  }
  @Patch('units/:id') @RequiresPermission('catalog.unit.manage') updateUnit(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateUnit(getTenantContext().tenantId, id, unitPatchSchema.parse(body));
  }
  @Delete('units/:id') @RequiresPermission('catalog.unit.manage') removeUnit(@Param('id') id: string) {
    return this.catalog.removeUnit(getTenantContext().tenantId, id);
  }
  @Get('tax-groups') @RequiresPermission('catalog.taxgroup.view') taxGroups() {
    return this.catalog.listTaxGroups(getTenantContext().tenantId);
  }
  @Post('tax-groups') @RequiresPermission('catalog.taxgroup.manage') createTaxGroup(@Body() body: unknown) {
    return this.catalog.createTaxGroup(getTenantContext().tenantId, taxGroupSchema.parse(body));
  }
  @Patch('tax-groups/:id') @RequiresPermission('catalog.taxgroup.manage') updateTaxGroup(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.catalog.updateTaxGroup(getTenantContext().tenantId, id, taxGroupPatchSchema.parse(body));
  }
}
