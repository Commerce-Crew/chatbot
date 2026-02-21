<?php declare(strict_types=1);

namespace CommerceCrew\CCChatbot\Service;

use Shopware\Core\Content\Cms\CmsPageEntity;

/**
 * Extracts plain text from a CMS page for use in chatbot context (contact, return policy, about us).
 */
class CmsPageTextExtractor
{
    public function extractFromCmsPage(CmsPageEntity $cmsPage): string
    {
        $parts = [];
        $sections = $cmsPage->getSections();
        if ($sections === null) {
            return '';
        }

        foreach ($sections->getElements() as $section) {
            $blocks = $section->getBlocks();
            if ($blocks === null) {
                continue;
            }
            foreach ($blocks->getElements() as $block) {
                $slots = $block->getSlots();
                if ($slots === null) {
                    continue;
                }
                foreach ($slots->getElements() as $slot) {
                    $text = $this->extractTextFromSlot($slot);
                    if ($text !== '') {
                        $parts[] = $text;
                    }
                }
            }
        }

        return implode("\n\n", array_filter($parts));
    }

    private function extractTextFromSlot(object $slot): string
    {
        $config = method_exists($slot, 'getConfig') ? $slot->getConfig() : null;
        if (\is_array($config) && $config !== []) {
            $text = $this->collectTextFromArray($config);
            if ($text !== '') {
                return $text;
            }
        }
        if (method_exists($slot, 'getFieldConfig')) {
            $fieldConfig = $slot->getFieldConfig();
            if ($fieldConfig !== null && method_exists($fieldConfig, 'get')) {
                try {
                    $content = $fieldConfig->get('content');
                    if ($content !== null && method_exists($content, 'getValue')) {
                        $v = $content->getValue();
                        if (\is_string($v) && trim($v) !== '') {
                            return strip_tags(trim($v));
                        }
                    }
                } catch (\Throwable $e) {
                    // ignore
                }
            }
        }
        return '';
    }

    private function collectTextFromArray(array $arr): string
    {
        $parts = [];
        foreach ($arr as $key => $value) {
            if ($key === 'content' && \is_array($value)) {
                $v = $value['value'] ?? $value['source'] ?? null;
                if (\is_string($v) && trim($v) !== '') {
                    $parts[] = strip_tags(trim($v));
                }
                continue;
            }
            if (\is_string($value) && trim($value) !== '' && !str_starts_with($value, 'data:')) {
                $parts[] = strip_tags(trim($value));
            }
            if (\is_array($value)) {
                $nested = $this->collectTextFromArray($value);
                if ($nested !== '') {
                    $parts[] = $nested;
                }
            }
        }
        return implode(' ', $parts);
    }
}
