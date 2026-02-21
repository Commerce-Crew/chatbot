<?php declare(strict_types=1);

namespace CommerceCrew\CCChatbot\Storefront\Controller;

use CommerceCrew\CCChatbot\Service\CmsPageTextExtractor;
use Shopware\Core\Content\Cms\CmsPageEntity;
use Shopware\Core\Content\LandingPage\LandingPageEntity;
use Shopware\Core\Content\Category\CategoryEntity;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use Shopware\Storefront\Controller\StorefrontController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route(defaults: ['_routeScope' => ['storefront']])]
class StorePagesController extends StorefrontController
{
    private const CONFIG_PREFIX = 'CCChatbot.config.';

    public function __construct(
        private readonly EntityRepository $landingPageRepository,
        private readonly EntityRepository $cmsPageRepository,
        private readonly EntityRepository $categoryRepository,
        private readonly CmsPageTextExtractor $cmsPageTextExtractor,
        private readonly SystemConfigService $systemConfigService
    ) {
    }

    /**
     * Returns plain-text content of configured store pages (contact, return policy, about us)
     * for use in chatbot context. IDs are from plugin config (landing page IDs).
     */
    #[Route(
        path: '/ccchatbot/store-pages',
        name: 'frontend.ccchatbot.store_pages',
        methods: ['GET'],
        defaults: [
            '_httpCache' => false,
            'XmlHttpRequest' => true,
        ]
    )]
    public function storePages(SalesChannelContext $context, Request $request): JsonResponse
    {
        $salesChannelId = $context->getSalesChannelId();
        $config = $this->getConfig($salesChannelId);

        $contactPageId = $config['contactPageId'] ?? null;
        $returnPolicyPageId = $config['returnPolicyPageId'] ?? null;
        $aboutUsPageId = $config['aboutUsPageId'] ?? null;

        $contact = $this->getTextFromPageId((string) $contactPageId, $context) ?: ($config['shopContact'] ?? '');
        $returnPolicy = $this->getTextFromPageId((string) $returnPolicyPageId, $context) ?: ($config['shopReturnPolicy'] ?? '');
        $aboutUs = $this->getTextFromPageId((string) $aboutUsPageId, $context) ?: ($config['shopAboutUs'] ?? '');

        $payload = [
            'success' => true,
            'contact' => trim((string) $contact),
            'returnPolicy' => trim((string) $returnPolicy),
            'aboutUs' => trim((string) $aboutUs),
        ];

        $response = new JsonResponse($payload);
        $response->headers->set('Cache-Control', 'private, max-age=300'); // 5 min cache

        return $response;
    }

    private function getConfig(string $salesChannelId): array
    {
        $get = fn (string $key): string => trim((string) ($this->systemConfigService->get(self::CONFIG_PREFIX . $key, $salesChannelId) ?? ''));
        return [
            'contactPageId' => $get('contactPageId') ?: null,
            'returnPolicyPageId' => $get('returnPolicyPageId') ?: null,
            'aboutUsPageId' => $get('aboutUsPageId') ?: null,
            'shopContact' => $get('shopContact'),
            'shopReturnPolicy' => $get('shopReturnPolicy'),
            'shopAboutUs' => $get('shopAboutUs'),
        ];
    }

    /**
     * Load page text by UUID. Tries: landing page, CMS page, then category (Admin → Category ID).
     */
    private function getTextFromPageId(string $pageId, SalesChannelContext $context): string
    {
        $pageId = trim($pageId);
        if ($pageId === '' || !$this->isValidUuid($pageId)) {
            return '';
        }

        $cmsPage = $this->loadCmsPageViaLandingPage($pageId, $context);
        if ($cmsPage === null) {
            $cmsPage = $this->loadCmsPageById($pageId, $context);
        }
        if ($cmsPage === null) {
            $cmsPage = $this->loadCmsPageViaCategory($pageId, $context);
        }
        if ($cmsPage === null) {
            return '';
        }

        return $this->cmsPageTextExtractor->extractFromCmsPage($cmsPage);
    }

    private function loadCmsPageViaLandingPage(string $landingPageId, SalesChannelContext $context): ?CmsPageEntity
    {
        $criteria = new Criteria([$landingPageId]);
        $criteria->addAssociation('cmsPage.sections.blocks.slots');

        /** @var LandingPageEntity|null $landingPage */
        $landingPage = $this->landingPageRepository->search($criteria, $context->getContext())->first();
        if ($landingPage === null) {
            return null;
        }

        return $landingPage->getCmsPage();
    }

    private function loadCmsPageById(string $cmsPageId, SalesChannelContext $context): ?CmsPageEntity
    {
        $criteria = new Criteria([$cmsPageId]);
        $criteria->addAssociation('sections.blocks.slots');

        /** @var CmsPageEntity|null $cmsPage */
        $cmsPage = $this->cmsPageRepository->search($criteria, $context->getContext())->first();

        return $cmsPage;
    }

    /**
     * Load CMS page via category ID (e.g. ID from Admin → Catalog → Categories, or URL like .../category/index/{id}/base).
     */
    private function loadCmsPageViaCategory(string $categoryId, SalesChannelContext $context): ?CmsPageEntity
    {
        $criteria = new Criteria([$categoryId]);
        $criteria->addAssociation('cmsPage.sections.blocks.slots');

        /** @var CategoryEntity|null $category */
        $category = $this->categoryRepository->search($criteria, $context->getContext())->first();
        if ($category === null) {
            return null;
        }

        return $category->getCmsPage();
    }

    private function isValidUuid(string $id): bool
    {
        return (bool) preg_match('/^[0-9a-f]{32}$/i', $id);
    }
}
