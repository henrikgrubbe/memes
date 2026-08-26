import {describe, expect, it} from "vitest";
import {assetUrl, displayImageUrl} from "./assets.js";

describe("assetUrl", () => {
    it("builds the public release-asset download URL for a meme", () => {
        expect(assetUrl("henrikgrubbe/memes", "abc-123"))
            .toBe("https://github.com/henrikgrubbe/memes/releases/download/memes/abc-123.jpg");
    });
});

describe("displayImageUrl", () => {
    it("wraps the release-asset URL in the image proxy for inline rendering", () => {
        expect(displayImageUrl("henrikgrubbe/memes", "abc-123"))
            .toBe("https://images.weserv.nl/?url=github.com/henrikgrubbe/memes/releases/download/memes/abc-123.jpg");
    });
});
