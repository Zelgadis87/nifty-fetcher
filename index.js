
const request = require( 'request-promise' )
	, requestErrors = require( 'request-promise/errors' )
	, Bluebird = require( 'bluebird' )
	, _ = require( 'lodash' )
	, path = require( 'path' )
	, console = require( 'console' )
	, xpath = require( 'xpath.js' )
	, DOMParser = require( 'xmldom' ).DOMParser
	, MultiSpinner = require( 'multispinner' )
	, yazl = require( 'yazl' )
	, fs = Bluebird.promisifyAll( require( 'fs' ) )
	, enquirer = createEnquirer( require( 'enquirer' ) )
	, loadYaml = require( 'js-yaml' ).load
	;

Bluebird.longStackTraces();

let baseUrl = 'http://www.nifty.org/nifty';

function createEnquirer( Enquirer ) {
	let e = new Enquirer();
	e.register( 'list', require( 'prompt-list' ) );
	return e;
}

function urlTemplate( orientation, category, title ) {
	return `${ baseUrl }/${ orientation }/${ category }/${ title }/`;
}

function recursiveMkDir( argDir ) {
	var promise = Bluebird.resolve(),
		currentPath = "";
	_.each( argDir.split( path.sep ), function( argSplit, argIdx ) {
		currentPath = path.join( currentPath, argSplit + '\\' );
		if ( argIdx == 0 ) return; // Skip mkdir-ing the drive.
		promise = promise
			.return( currentPath )
			.then( fs.mkdirAsync )
			.catch( ( err ) => {
				// Output folder already existing is expected, it's not a problem.
				// Other types of error should be thrown.
				if ( err.code !== 'EEXIST' ) throw err;
			} );
	} );
	return promise;
}

function downloadLink( baseUrl, link ) {
	return request( baseUrl + link ).then( data => {
		return {
			href: link,
			name: path.basename( link ),
			content: data
		};
	} );
}

async function askOrientation( orientations ) {
	return enquirer.ask( {
		name: 'orientation',
		message: 'Orientation?',
		type: 'list',
		choices: orientations
	} ).then( answers => answers.orientation );
}

async function askCategory( orientation, categories ) {
	let choices = [ '<' ].concat( categories );
	return enquirer.ask( {
		name: 'category',
		message: 'Category?',
		type: 'list',
		choices: choices
	} ).then( answers => answers.category );
}

async function askName( ) {
	return enquirer.ask( {
		name: 'name',
		message: 'Archive name?',
		type: 'input'
	} ).then( answers => answers.name );
}

async function askQuestions() {
	let orientation, category, name;
	let yml = loadYaml( fs.readFileSync( 'nifty.yml', 'UTF-8' ) );

	while ( !orientation || !category || !name ) {
		if ( !orientation ) {
			orientation = await askOrientation( yml.orientations );
		} else if ( !category ) {
			category = await askCategory( orientation, yml.categories[ orientation ] );
			if ( category === '<' ) category = orientation = false;
		} else if ( !name ) {
			name = await askName( );
			if ( name === '<' ) name = category = false;
		}
	}

	return [ orientation, category, name ];
}

async function main() {

	let [ orientation, category, name ] = await askQuestions();
	let url = urlTemplate( orientation, category, name );

	let dataDir = path.join( __dirname, 'data' );
	let outputName = `${ name }.zip`;
	let outputPath = path.join( dataDir, outputName );

	class RuntimeError extends Error {};

	return Bluebird.resolve( recursiveMkDir( dataDir ) )
		.tap( () => console.info( 'Fetching archive info...' ) )
		.then( () => request( url ).catch( requestErrors.StatusCodeError, err => { if ( err.statusCode === 404 ) throw new RuntimeError( 'Could not find archive at ' + url ); throw err; } ) )
		.then( html => new DOMParser( { errorHandler: _.noop } ).parseFromString( html ) )
		.then( dom => xpath( dom, '//table/descendant::a/@href' ) )
		.map( href => href.value )
		.tap( () => console.info( 'Fetch complete. Downloading contents...' ) )
		.then( links => {
			return new Bluebird( resolve => {

				let spinners = new MultiSpinner( links );
				let data = Bluebird.map( links, link => downloadLink( url, link )
					.then( d => {
						spinners.success( link );
						return d;
					}, d => {
						spinners.error( link );
						return d;
					} )
				);
				spinners.on( 'done', () => resolve( data ) );

			} );
		} )
		.tap( () => console.info( 'Download complete. Processing contents...' ) )
		.then( data => {
			return new Bluebird( ( resolve ) => {

				let spinner = new MultiSpinner( [ outputName ] );
				let zipfile = new yazl.ZipFile();

				zipfile.outputStream.pipe( fs.createWriteStream( outputPath ) ).on( 'close', () => spinner.success( outputName ) );
				_.each( data, ( d, i ) => zipfile.addBuffer( new Buffer( d.content ), `${ _.padStart( i + 1, data.length.toString().length, '0' ) }-${ d.name }` ) );
				zipfile.end();

				spinner.on( 'done', resolve );

			} );
		} )
		.tap( () => console.info( 'Process complete. Output available as: ' + outputPath ) )
		.catch( RuntimeError, err => console.error( err.message ) );

}

main();
