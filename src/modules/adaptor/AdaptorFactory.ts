import { BaseAdaptor } from './BaseAdaptor';
import { Venders } from '../configuration/configuration.constants';

type AdaptorConstructor = new (baseURL: string, apiKey: string, provider: Venders) => BaseAdaptor;

export class AdaptorFactory {
    static readonly #registry = new Map<Venders, AdaptorConstructor>();

    static register(provider: Venders, adaptor: AdaptorConstructor): void {
        AdaptorFactory.#registry.set(provider, adaptor);
    }

    static create(provider: Venders, baseURL: string, apiKey: string): BaseAdaptor {
        const AdaptorClass = AdaptorFactory.#registry.get(provider);
        if (!AdaptorClass) {
            throw new Error(`${provider} is not registered by Dispatcher.`);
        }
        return new AdaptorClass(baseURL, apiKey, provider);
    }
}
