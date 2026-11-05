export const PRODUCT_KEY = "sku-demo";

export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  version: number;
}

export const fixedProduct: Readonly<Product> = Object.freeze({
  sku: PRODUCT_KEY,
  name: "Demo product",
  priceCents: 1299,
  version: 1,
});
