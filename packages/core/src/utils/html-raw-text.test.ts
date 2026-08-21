/** Tests the bounded HTML raw-text tokenizer against browser end-tag states. */

import { describe, expect, it } from "vitest";
import { stripHtmlRawTextElements } from "./html-raw-text";

describe("stripHtmlRawTextElements", () => {
	it.each([
		["ordinary", "<script>hidden</script>"],
		["mixed case", "<ScRiPt>hidden</sCrIpT>"],
		["whitespace", "<style>hidden</style \t>"],
		["trailing attribute", "<script>hidden</script data-x=1>"],
		["slash delimiter", "<style>hidden</style/ignored>"],
		["quoted closer material", "<script>hidden</script data-x='>' >"],
	])("removes %s raw-text markup", (_label, markup) => {
		expect(stripHtmlRawTextElements(`before${markup}after`)).toBe(
			"before after",
		);
	});

	it("does not accept a non-delimited end-tag name", () => {
		expect(
			stripHtmlRawTextElements(
				"before<script>first</scriptx>second</script>after",
			),
		).toBe("before after");
	});

	it.each([":", "=", "!", "?", ".", "-"])(
		"keeps a %s-delimited end-tag lookalike inside raw text",
		(punctuation) => {
			expect(
				stripHtmlRawTextElements(
					`before<script>first</script${punctuation}lookalike>second</sCrIpT data-x=1>after`,
				),
			).toBe("before after");
		},
	);

	it.each(["text<script", "text<style"])(
		"treats end of input as an opening tag-name delimiter, matching eof-in-tag",
		(markup) => {
			expect(stripHtmlRawTextElements(markup)).toBe("text ");
		},
	);

	it("strips through EOF when a closing tag name abuts end of input", () => {
		expect(stripHtmlRawTextElements("a<script>bad</script")).toBe("a ");
	});

	it.each(["<script>hidden", "<style data-x='>' hidden"])(
		"removes an unclosed raw-text element through EOF",
		(markup) => {
			expect(stripHtmlRawTextElements(`before${markup}`)).toBe("before ");
		},
	);

	it("is linear and preserves text around a large raw-text body", () => {
		const body = "x".repeat(250_000);
		expect(
			stripHtmlRawTextElements(
				`before<script data-x=">">${body}</script trailing>after`,
			),
		).toBe("before after");
	});
});
