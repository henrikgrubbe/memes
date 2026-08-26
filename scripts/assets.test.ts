import {describe, expect, it} from "vitest";
import {assetUrl} from "./assets.js";

describe("assetUrl", () => {
    it("builds the public release-asset download URL for a meme", () => {
        expect(assetUrl("henrikgrubbe/memes", "abc-123"))
            .toBe("https://github.com/henrikgrubbe/memes/releases/download/memes/abc-123.jpg");
    });
});
