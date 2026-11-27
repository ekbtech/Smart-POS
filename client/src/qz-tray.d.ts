declare module "qz-tray" {
  interface QzTrayApi {
    security: {
      setCertificatePromise(
        handler: (resolve: (certificate: string) => void, reject: (error: unknown) => void) => void,
      ): void;
      setSignatureAlgorithm(algorithm: "SHA512"): void;
      setSignaturePromise(
        handler: (request: string) => (resolve: (signature: string) => void, reject: (error: unknown) => void) => void,
      ): void;
    };
    websocket: {
      isActive(): boolean;
      connect(options?: { retries?: number; delay?: number }): Promise<void>;
    };
    printers: {
      find(): Promise<string[]>;
    };
    configs: {
      create(printer: string, options: {
        margins: number;
        orientation: "portrait";
        scaleContent: boolean;
        colorType: "blackwhite";
        units: "mm";
      }): unknown;
    };
    print(config: unknown, data: Array<{
      type: "pixel";
      format: "html";
      flavor: "plain";
      data: string;
      options: { pageWidth: number };
    }>): Promise<void>;
  }

  const qz: QzTrayApi;
  export default qz;
}

declare module "qz-tray";
